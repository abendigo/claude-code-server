import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { slugify } from '../server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7790 + Math.floor(Math.random() * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gw;
let log = '';

before(async () => {
  gw = spawn('node', [path.join(here, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), AGENT_MAX_PER_USER: '2', AGENT_SPAWN_JSON: JSON.stringify(['node', path.join(here, 'fake-bridge.mjs')]) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gw.stdout.on('data', (d) => { log += d; });
  gw.stderr.on('data', (d) => { log += d; });
  await sleep(600);
});
after(() => gw.kill());

const open = (headers, urlPath = '/ws') => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${urlPath}`, { headers });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  ws.on('open', () => resolve({ ws, msgs, ok: true }));
  ws.on('unexpected-response', (_q, res) => resolve({ ok: false, status: res.statusCode }));
  ws.on('error', () => {});
});

test('rejects: no user, wrong path, cross-site origin, unusable user name', async () => {
  assert.equal((await open({})).status, 401);
  assert.equal((await open({ 'Remote-User': 'a@b.c' }, '/nope')).status, 404);
  assert.equal((await open({ 'Remote-User': 'a@b.c', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await open({ 'Remote-User': '@@@' })).status, 401);
});

test('same-origin connection relays protocol lines, surfaces status, hides bridge logs', async () => {
  const a = await open({ 'Remote-User': 'Mark@Oosterveld.org', Origin: `http://127.0.0.1:${PORT}` });
  assert.ok(a.ok);
  await sleep(500);
  assert.ok(a.msgs.some((m) => m.type === 'hello'));
  assert.ok(a.msgs.some((m) => m.type === 'status' && m.text === 'plain non-json line'));
  assert.ok(a.msgs.some((m) => m.type === 'status' && /creating environment/.test(m.text)));
  assert.ok(!a.msgs.some((m) => /hidden log/.test(JSON.stringify(m))));
  a.ws.close();
  await sleep(300);
});

test('only prompt/permission/interrupt reach the bridge; junk is rejected', async () => {
  const a = await open({ 'Remote-User': 'u1@x.org' });
  await sleep(300);
  a.ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }));
  a.ws.send(JSON.stringify({ type: 'bogus' }));
  a.ws.send('not json');
  await sleep(300);
  assert.ok(a.msgs.some((m) => m.type === 'echo' && m.got.text === 'hi'));
  assert.equal(a.msgs.filter((m) => m.type === 'error').length, 2);
  assert.ok(!a.msgs.some((m) => m.type === 'echo' && m.got.type === 'bogus'));
  a.ws.close();
  await sleep(300);
});

test('per-user connection limit, freed on close; other users unaffected', async () => {
  const h = { 'Remote-User': 'limit@x.org' };
  const a = await open(h);
  const b = await open(h);
  assert.ok(a.ok && b.ok);
  assert.equal((await open(h)).status, 429);
  const other = await open({ 'Remote-User': 'other@x.org' });
  assert.ok(other.ok);
  other.ws.close();
  a.ws.close();
  await sleep(500);
  const again = await open(h);
  assert.ok(again.ok);
  again.ws.close();
  b.ws.close();
  await sleep(300);
});

test('closing the websocket ends the bridge process', async () => {
  const a = await open({ 'Remote-User': 'life@x.org' });
  await sleep(400);
  const pid = a.msgs.find((m) => m.type === 'hello').pid;
  a.ws.close();
  await sleep(800);
  assert.throws(() => process.kill(pid, 0));
});

// Same person must land in the same worker through ttyd and through here.
test('slugify matches the shell normalisation in scripts/ttyd-dispatch', () => {
  const shell = (raw) => execFileSync('bash', ['-c',
    `printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_.-]+/-/g; s/-{2,}/-/g; s/^[-._]+//; s/[-._]+$//' | cut -c1-64`, '_', raw]).toString().replace(/\n$/, '');
  for (const i of ['mark@oosterveld.org', 'Mark.Smith+tag@Example.COM', '__weird..name__', 'a  b   c', '---', '', 'UPPER_case-Name.x', `${'x'.repeat(90)}@y.org`, 'trailing.dots...', 'a@b@c', 'tab\there']) {
    assert.equal(slugify(i), shell(i), JSON.stringify(i));
  }
});
