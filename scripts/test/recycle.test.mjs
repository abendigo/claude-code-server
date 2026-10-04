// Run with: node --test scripts/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scratch "gateway": fake docker on PATH, recycle-worker where the watcher expects it.
function setup(containers, { latest = 'sha256:new', current = 'sha256:old', pullFail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recycle-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(here, 'fake-docker'), path.join(bin, 'docker'));
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  // The watcher calls /usr/local/bin/recycle-worker; point that at the repo copy via a wrapper env.
  const wrapper = path.join(bin, 'recycle-worker');
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec bash ${path.join(scripts, 'recycle-worker')} "$@"\n`, { mode: 0o755 });
  const watcher = path.join(dir, 'watch');
  fs.writeFileSync(watcher, fs.readFileSync(path.join(scripts, 'watch-recycle-requests'), 'utf8').replaceAll('/usr/local/bin/recycle-worker', wrapper), { mode: 0o755 });
  const root = path.join(dir, 'ws');
  for (const c of containers) fs.mkdirSync(path.join(root, c), { recursive: true });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: path.join(dir, 'docker.log'), FAKE_ROOT: root,
    FAKE_CONTAINERS: containers.join(' '), FAKE_LATEST: latest, FAKE_CURRENT: current, RECYCLE_NOTICE_SECONDS: '0',
    ...(pullFail ? { FAKE_PULL_FAIL: '1' } : {}),
  };
  fs.writeFileSync(env.FAKE_LOG, '');
  const log = () => fs.readFileSync(env.FAKE_LOG, 'utf8');
  const ws = (c) => path.join(root, c);
  const runWatcher = () => spawnSync('bash', [watcher, '--once'], { env, encoding: 'utf8' });
  // Run update-worker as the container `c` would, concurrently, so the watcher can answer it.
  const askFromWorker = (c, args = [], extraEnv = {}) => {
    const p = spawn('bash', [path.join(scripts, 'update-worker'), ...args], { env: { ...env, WORKSPACE_DIR: ws(c), ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const done = new Promise((resolve) => p.on('exit', (code) => resolve({ code, out })));
    return done;
  };
  return { env, log, ws, runWatcher, askFromWorker };
}
const stopped = (log, c) => log.includes(`docker stop -t 30 ${c}`) && log.includes(`docker rm ${c}`);

test('stale image: the worker is told, then stopped and removed', async () => {
  const c = 'claude-code-user-mark';
  const s = setup([c]);
  const asked = s.askFromWorker(c);
  await sleep(700);
  const w = s.runWatcher();
  const r = await asked;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /newer worker image is available/);
  assert.ok(stopped(s.log(), c), s.log());
  assert.ok(!fs.existsSync(path.join(s.ws(c), '.recycle-request')), 'request consumed');
  assert.match(w.stdout, /asked for an update/);
});

test('already current: told so, and nothing is stopped', async () => {
  const c = 'claude-code-user-mark';
  const s = setup([c], { latest: 'sha256:same', current: 'sha256:same' });
  const asked = s.askFromWorker(c);
  await sleep(700);
  s.runWatcher();
  const r = await asked;
  assert.equal(r.code, 0);
  assert.match(r.out, /Already up to date/);
  assert.ok(!s.log().includes('docker stop') && !s.log().includes('docker rm'));
});

test('--force recycles even when current', async () => {
  const c = 'claude-code-user-mark';
  const s = setup([c], { latest: 'sha256:same', current: 'sha256:same' });
  const asked = s.askFromWorker(c, ['--force']);
  await sleep(700);
  s.runWatcher();
  const r = await asked;
  assert.match(r.out, /forced/);
  assert.ok(stopped(s.log(), c));
});

test('registry unreachable: reported, nothing changed', async () => {
  const c = 'claude-code-user-mark';
  const s = setup([c], { pullFail: true });
  const asked = s.askFromWorker(c);
  await sleep(700);
  s.runWatcher();
  const r = await asked;
  assert.match(r.out, /Could not reach the image registry/);
  assert.ok(!s.log().includes('docker stop'));
});

test('no request: the watcher does nothing', () => {
  const s = setup(['claude-code-user-a', 'claude-code-user-b']);
  s.runWatcher();
  assert.ok(!s.log().includes('docker stop') && !s.log().includes('docker rm') && !s.log().includes('docker pull'));
});

test('only the worker that asked is recycled', async () => {
  const [a, b] = ['claude-code-user-a', 'claude-code-user-b'];
  const s = setup([a, b]);
  const asked = s.askFromWorker(a);
  await sleep(700);
  s.runWatcher();
  await asked;
  assert.ok(stopped(s.log(), a));
  assert.ok(!s.log().includes(`docker stop -t 30 ${b}`) && !s.log().includes(`docker rm ${b}`));
});

test('no gateway answering: update-worker gives up cleanly and withdraws its request', async () => {
  const c = 'claude-code-user-mark';
  const s = setup([c]);
  const r = await s.askFromWorker(c, [], { UPDATE_WAIT_SECONDS: '2' });
  assert.equal(r.code, 1);
  assert.match(r.out, /No answer from the gateway/);
  assert.ok(!fs.existsSync(path.join(s.ws(c), '.recycle-request')));
});

test('bad arguments are rejected', () => {
  const r = spawnSync('bash', [path.join(scripts, 'update-worker'), '--bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const r2 = spawnSync('bash', [path.join(scripts, 'recycle-worker')], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
});
