// reap-idle-users: stops workers nobody has been connected to for a while, but
// not while Claude is still working in them (the session service keeps going
// with the headset off). Run with: node --test scripts/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..');

function setup(users, { busy = [], stale = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(here, 'fake-docker'), path.join(bin, 'docker'));
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  // Inside each fake worker, `agent-service busy` succeeds only for the users listed as busy.
  fs.writeFileSync(path.join(bin, 'agent-service'), '#!/bin/bash\n[ "$1" = busy ] && case " $FAKE_BUSY_USERS " in *" ${FAKE_CONTAINER#claude-code-user-} "*) exit 0 ;; esac\nexit 1\n', { mode: 0o755 });
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  const now = Math.floor(Date.now() / 1000);
  for (const [name, ageSeconds] of Object.entries(users)) fs.writeFileSync(path.join(state, `${name}.lastseen`), String(now - ageSeconds));
  const root = path.join(dir, 'ws');
  const containers = Object.keys(users).map((n) => `claude-code-user-${n}`);
  for (const c of containers) fs.mkdirSync(path.join(root, c), { recursive: true });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE_DIR: state, IDLE_TIMEOUT_SECONDS: '7200',
    FAKE_LOG: path.join(dir, 'docker.log'), FAKE_ROOT: root, FAKE_CONTAINERS: containers.join(' '),
    FAKE_LATEST: 'sha256:new', FAKE_CURRENT: stale ? 'sha256:old' : 'sha256:new', FAKE_BUSY_USERS: busy.join(' '),
  };
  fs.writeFileSync(env.FAKE_LOG, '');
  const run = () => spawnSync('bash', [path.join(scripts, 'reap-idle-users'), '--once'], { env, encoding: 'utf8' });
  return { run, log: () => fs.readFileSync(env.FAKE_LOG, 'utf8') };
}
const stopped = (log, user) => log.includes(`docker stop -t 30 claude-code-user-${user}`);
const removed = (log, user) => log.includes(`docker rm claude-code-user-${user}`);

test('an idle worker is stopped; a recently used one is left alone', () => {
  const s = setup({ idle: 8000, recent: 100 });
  const r = s.run();
  assert.ok(stopped(s.log(), 'idle'), s.log());
  assert.ok(!stopped(s.log(), 'recent'));
  assert.match(r.stdout, /'idle' idle 8\d\d\ds -- stopping/);
});

test('an idle worker where Claude is still working is left running, and says why', () => {
  const s = setup({ busyone: 8000, quiet: 8000 }, { busy: ['busyone'] });
  const r = s.run();
  assert.ok(!stopped(s.log(), 'busyone'), s.log());
  assert.ok(stopped(s.log(), 'quiet'), 'the other idle worker is still stopped');
  assert.match(r.stdout, /'busyone' has been disconnected \d+s but Claude is still working there/);
});

test('busy and running a stale image: still not removed', () => {
  const s = setup({ busyone: 8000 }, { busy: ['busyone'], stale: true });
  s.run();
  assert.ok(!stopped(s.log(), 'busyone') && !removed(s.log(), 'busyone'), s.log());
});

test('idle and stale and not busy: stopped and removed, as before', () => {
  const s = setup({ idle: 8000 }, { stale: true });
  s.run();
  assert.ok(stopped(s.log(), 'idle') && removed(s.log(), 'idle'), s.log());
});

test('with no state files nothing happens', () => {
  const s = setup({});
  s.run();
  assert.ok(!s.log().includes('docker stop'));
});
