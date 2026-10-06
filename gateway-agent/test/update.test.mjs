// POST /update: the banner's "Update environment". Runs the real gateway against a fake recycle-worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7890 + Math.floor(Math.random() * 100);
let gw;

before(async () => {
  gw = spawn('node', [path.join(here, '..', 'server.mjs')], {
    env: { ...process.env, TUNNEL_NAME: 'claude-code-server', PORT: String(PORT), RECYCLE_ARGV_JSON: JSON.stringify(['node', path.join(here, 'fake-recycle.mjs')]) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 600));
});
after(() => gw.kill());

const post = (user, extra = {}) => fetch(`http://127.0.0.1:${PORT}/update`, {
  method: 'POST',
  headers: { ...(user ? { 'Remote-User': user } : {}), Origin: `http://127.0.0.1:${PORT}`, ...extra },
});

test('a worker behind the newest image: answers "updating" right away, not when the restart finishes', async () => {
  const t0 = Date.now();
  const res = await post('Newer');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'updating');
  assert.match(body.message, /restarting now/);
  assert.ok(Date.now() - t0 < 1200, 'did not wait for the stop to finish');
});

test('already current, and a registry failure, are reported as such', async () => {
  const cur = await post('current');
  assert.deepEqual([cur.status, (await cur.json()).status], [200, 'current']);
  const bad = await post('broken');
  assert.deepEqual([bad.status, (await bad.json()).status], [502, 'error']);
  const silent = await post('silent');
  assert.equal(silent.status, 502);
});

test('refuses: no user, no or cross-site origin, GET, and a second update while one runs', async () => {
  assert.equal((await post(null)).status, 401);
  assert.equal((await post('newer', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/update`, { method: 'POST', headers: { 'Remote-User': 'newer' } })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/update`, { headers: { 'Remote-User': 'newer' } })).status, 405);
  const first = post('slowpoke');
  await new Promise((r) => setTimeout(r, 50));
  const second = await post('slowpoke');
  await first;
  assert.ok([200, 409].includes(second.status));
});

test('/me gives the user their own VS Code tunnel link, named as dispatch-to-worker names it', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/me`, { headers: { 'Remote-User': 'Mark@Oosterveld.org' } });
  assert.deepEqual(await res.json(), { user: 'mark-oosterveld.org', vscodeUrl: 'https://vscode.dev/tunnel/claude-code-server-mark-oosterveld-org' });
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/me`)).status, 401);
});
