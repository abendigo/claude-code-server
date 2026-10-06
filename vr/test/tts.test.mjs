// The hub's /api/tts, run for real as a child process against a fake speech service.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const SERVER = new URL('../server/server.js', import.meta.url).pathname;

async function fakeUpstream(status = 200) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(status, { 'Content-Type': status === 200 ? 'audio/mpeg' : 'text/plain' });
    res.end(status === 200 ? Buffer.from('ID3-fake-mp3') : 'nope');
  }).listen(0);
  await once(srv, 'listening');
  return { srv, seen, url: `http://localhost:${srv.address().port}/v1/audio/speech` };
}

async function hub(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: String(port), CLIENT_DIR: '/nonexistent', BAKED_CLIENT_DIR: '/nonexistent', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => child.stdout.on('data', (d) => String(d).includes('listening') && resolve()));
  const call = (path, init = {}) => fetch(`http://localhost:${port}${path}`, { ...init, headers: { 'Remote-User': 'mark', ...(init.headers ?? {}) } });
  return { call, stop: () => child.kill() };
}
const post = (text) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });

test('POST /api/tts sends the text to the speech service and returns its audio', async () => {
  const up = await fakeUpstream();
  const h = await hub({ STT_API_KEY: 'sk-test', TTS_URL: up.url, TTS_VOICE: 'nova' });
  try {
    const res = await h.call('/api/tts', post('All done.'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ID3-fake-mp3');
    assert.deepEqual(up.seen[0], { auth: 'Bearer sk-test', body: { model: 'tts-1', voice: 'nova', input: 'All done.', response_format: 'mp3' } });
    assert.equal((await (await h.call('/config.json')).json()).ttsEnabled, true);
  } finally { h.stop(); up.srv.close(); }
});

test('rejects missing, malformed and over-long text without calling the speech service', async () => {
  const up = await fakeUpstream();
  const h = await hub({ STT_API_KEY: 'sk-test', TTS_URL: up.url });
  try {
    assert.equal((await h.call('/api/tts', post('  '))).status, 400);
    assert.equal((await h.call('/api/tts', post('x'.repeat(601)))).status, 413);
    assert.equal((await h.call('/api/tts', { method: 'POST', body: 'not json' })).status, 400);
    assert.equal(up.seen.length, 0);
  } finally { h.stop(); up.srv.close(); }
});

test('without a key, or with TTS_ENABLED=0, it is off and says so', async () => {
  const none = await hub({});
  const off = await hub({ STT_API_KEY: 'sk-test', TTS_ENABLED: '0' });
  try {
    assert.equal((await none.call('/api/tts', post('hi'))).status, 503);
    assert.equal((await none.call('/config.json').then((r) => r.json())).ttsEnabled, false);
    assert.equal((await off.call('/api/tts', post('hi'))).status, 503);
  } finally { none.stop(); off.stop(); }
});

test('an upstream failure becomes a 502 with a readable message', async () => {
  const up = await fakeUpstream(401);
  const h = await hub({ STT_API_KEY: 'sk-bad', TTS_URL: up.url });
  try {
    const res = await h.call('/api/tts', post('hi'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /401/);
  } finally { h.stop(); up.srv.close(); }
});

test('the speech URL defaults to the speech-to-text provider, and it needs a login header', async () => {
  const up = await fakeUpstream();
  const h = await hub({ STT_API_KEY: 'k', STT_URL: up.url.replace('/audio/speech', '/audio/transcriptions') });
  try {
    assert.equal((await h.call('/api/tts', post('hi'))).status, 200);
    assert.equal(up.seen.length, 1);
  } finally { h.stop(); up.srv.close(); }
});
