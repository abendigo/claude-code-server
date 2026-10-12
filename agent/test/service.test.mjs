// The session service, run for real as a child process against a fake SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const SERVICE = new URL('../service.mjs', import.meta.url).pathname;
const ATTACH = new URL('../attach.mjs', import.meta.url).pathname;
const FAKE_SDK = new URL('./fake-sdk.mjs', import.meta.url).pathname;
const LOGIN_FAKE = `
console.log('If the browser did not open, visit: https://example.test/oauth/authorize?code=true&state=abc');
process.stdin.once('data', (d) => process.exit(String(d).trim() === 'good-code' ? 0 : 1));
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A throwaway home: a state dir, a socket, and a fake transcript store.
function sandbox(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
  const env = {
    ...process.env,
    HOME: home,
    AGENT_STATE_DIR: path.join(home, 'state'),
    AGENT_SOCKET: path.join(home, 's.sock'), // unix socket paths are short; keep it near the top
    AGENT_SDK_MODULE: FAKE_SDK,
    FAKE_DIR: path.join(home, 'transcripts'),
    AGENT_LOGIN_JSON: JSON.stringify([process.execPath, '-e', LOGIN_FAKE]),
    AGENT_SETTING_SOURCES: '',
    ...extra,
  };
  let child = null;
  const svc = {
    home, env,
    async start() {
      child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'ignore', process.env.DEBUG_SVC ? 'inherit' : 'ignore'] });
      for (let i = 0; i < 100; i++) {
        if (await new Promise((r) => { const s = net.connect(env.AGENT_SOCKET); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) return svc;
        await sleep(50);
      }
      throw new Error('service did not start');
    },
    stop() { child?.kill('SIGTERM'); child = null; },
    async restart() { svc.stop(); await sleep(150); return svc.start(); },
    busy() { return spawnSync(process.execPath, [SERVICE, 'busy'], { env }).status; },
    connect() { return viewer(env.AGENT_SOCKET); },
    cleanup() { svc.stop(); fs.rmSync(home, { recursive: true, force: true }); },
  };
  return svc;
}

function viewer(socketPath) {
  const sock = net.connect(socketPath);
  const seen = [];
  const waiters = [];
  sock.on('error', () => {}); // we destroy it ourselves to simulate a page going away
  readline.createInterface({ input: sock }).on('error', () => {}).on('line', (l) => { seen.push(JSON.parse(l)); waiters.splice(0).forEach((w) => w()); });
  const v = {
    seen,
    send: (m) => sock.write(JSON.stringify(m) + '\n'),
    // The next message (not yet taken) matching a type or predicate.
    async next(match, ms = 4000) {
      const test = typeof match === 'string' ? (m) => m.type === match : match;
      const deadline = Date.now() + ms;
      for (;;) {
        const i = seen.findIndex(test);
        if (i >= 0) return seen.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof match === 'string' ? match : 'a message'}; saw ${JSON.stringify(seen.map((m) => m.type))}`);
        await Promise.race([new Promise((r) => waiters.push(r)), sleep(50)]);
      }
    },
    close: () => sock.destroy(),
  };
  return new Promise((resolve, reject) => { sock.once('connect', () => resolve(v)); sock.once('error', reject); });
}

// What a history says, in order: your prompts and Claude's replies (init and result markers left out).
const said = (messages) => messages
  .filter((e) => e.type === 'user_prompt' || (e.type === 'sdk' && (e.message.type === 'assistant' || e.message.type === 'user')))
  .map((e) => (e.type === 'user_prompt' ? e.text : e.message.type === 'user' ? e.message.message.content : e.message.message.content[0].text));
const reply = (m) => m.type === 'sdk' && m.message.type === 'assistant';
const text = (m) => m.message.message.content[0].text;
const withService = (name, fn, extra) => test(name, async () => {
  const svc = sandbox(extra);
  try { await svc.start(); await fn(svc); } finally { svc.cleanup(); }
});

withService('attach starts a session; a prompt gets a reply; state goes working then idle', async (svc) => {
  const v = await svc.connect();
  v.send({ type: 'attach' });
  const at = await v.next('attached');
  assert.equal(at.state, 'idle');
  assert.equal(at.live, false, 'no SDK process until the first prompt');
  assert.deepEqual((await v.next('history')).messages, []);

  v.send({ type: 'prompt', text: 'hello' });
  assert.equal((await v.next('session_state')).state, 'working');
  assert.equal(text(await v.next(reply)), 'echo: hello');
  assert.equal((await v.next('session_state')).state, 'idle');
  assert.equal(v.seen.some((m) => m.type === 'user_prompt'), false, 'the sender is not sent its own prompt back');
});

withService('a second viewer sees the first one\'s prompt and reply, and catches up when it joins late', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  a.send({ type: 'prompt', text: 'one' });
  await a.next(reply);

  const b = await svc.connect();
  b.send({ type: 'attach', session });
  await b.next('attached');
  const hist = (await b.next('history')).messages;
  assert.deepEqual(said(hist), ['one', 'echo: one']);
  assert.ok(hist.some((e) => e.type === 'sdk' && e.message.subtype === 'init'), 'the init message is kept so a page learns the session id');

  a.send({ type: 'prompt', text: 'two' });
  assert.equal((await b.next('user_prompt')).text, 'two');
  assert.equal(text(await b.next(reply)), 'echo: two');
});

withService('work carries on when the viewer goes away, and a later viewer finds the result', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  a.send({ type: 'prompt', text: 'slow:1500 finished' });
  await a.next((m) => m.type === 'session_state' && m.state === 'working');
  a.close(); // headset off
  await sleep(60);
  assert.equal(svc.busy(), 0, 'busy while the turn runs');

  await sleep(1800);
  const b = await svc.connect();
  b.send({ type: 'attach', session });
  const at = await b.next('attached');
  assert.equal(at.state, 'idle');
  const hist = (await b.next('history')).messages;
  assert.deepEqual(said(hist), ['slow:1500 finished', 'echo: finished']);
  assert.equal(svc.busy(), 1, 'not busy once it is done');
});

withService('an approval waits indefinitely while nobody is attached, and is shown again on attach', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  a.send({ type: 'prompt', text: 'ask:rm -rf build' });
  const first = await a.next('permission_request');
  assert.equal(first.input.command, 'rm -rf build');
  a.close();
  await sleep(300);
  assert.equal(svc.busy(), 0, 'waiting for an answer counts as busy');

  const b = await svc.connect();
  b.send({ type: 'attach', session });
  assert.equal((await b.next('attached')).state, 'waiting');
  await b.next('history');
  const again = await b.next('permission_request');
  assert.equal(again.id, first.id);
  b.send({ type: 'permission', id: again.id, allow: false });
  assert.equal(text(await b.next(reply)), 'denied');
  assert.equal((await b.next((m) => m.type === 'session_state' && m.state === 'idle')).state, 'idle');
});

withService('answering in one viewer clears the card in the other', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  const b = await svc.connect();
  b.send({ type: 'attach', session });
  await b.next('history');
  a.send({ type: 'prompt', text: 'ask:ls' });
  const req = await a.next('permission_request');
  await b.next('permission_request');
  a.send({ type: 'permission', id: req.id, allow: true });
  assert.equal((await b.next('permission_cancelled')).id, req.id);
  assert.equal(text(await a.next(reply)), 'allowed');
});

withService('a page that never attaches works like the old bridge, and its session ends with it', async (svc) => {
  const v = await svc.connect();
  v.send({ type: 'prompt', text: 'hi' });
  assert.equal(text(await v.next(reply)), 'echo: hi');
  await v.next((m) => m.type === 'session_state' && m.state === 'idle');
  const ok = await svc.connect();
  ok.send({ type: 'list_sessions' });
  assert.equal((await ok.next('sessions')).list.filter((r) => r.session).length, 1);
  v.close();
  await sleep(150);
  ok.send({ type: 'list_sessions' });
  assert.equal((await ok.next('sessions')).list.filter((r) => r.session).length, 0, 'the old-style session went with its page');
});

withService('an old-style page that leaves mid-turn lets the turn finish, then the session ends', async (svc) => {
  const v = await svc.connect();
  v.send({ type: 'prompt', text: 'slow:600 x' });
  await v.next('session_state');
  v.close();
  await sleep(100);
  const ok = await svc.connect();
  ok.send({ type: 'list_sessions' });
  assert.equal((await ok.next('sessions')).list.filter((r) => r.session).length, 1, 'still running');
  await sleep(900);
  ok.send({ type: 'list_sessions' });
  assert.equal((await ok.next('sessions')).list.filter((r) => r.session).length, 0);
});

withService('at the cap, an idle unwatched session is shut down to make room; otherwise it says so', async (svc) => {
  const open = async () => { const v = await svc.connect(); v.send({ type: 'attach' }); const { session } = await v.next('attached'); await v.next('history'); return { v, session }; };
  const a = await open();
  a.v.send({ type: 'prompt', text: 'a' });
  await a.v.next(reply);
  a.v.send({ type: 'detach' }); // nobody watching, idle: a candidate
  const b = await open();
  b.v.send({ type: 'prompt', text: 'b' });
  await b.v.next(reply);

  const c = await open();
  c.v.send({ type: 'prompt', text: 'c' });
  assert.equal(text(await c.v.next(reply)), 'echo: c', 'room was made by stopping the idle one');
  const list = await (async () => { c.v.send({ type: 'list_sessions' }); return (await c.v.next('sessions')).list; })();
  assert.equal(list.find((r) => r.session === a.session).live, false);

  const d = await open();
  d.v.send({ type: 'prompt', text: 'd' }); // b and c are both watched
  assert.match((await d.v.next('error')).message, /2 sessions are already running/);
}, { AGENT_MAX_LIVE: '2' });

withService('an idle unwatched session is shut down after a while and resumes with its history', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  await a.next('history');
  a.send({ type: 'prompt', text: 'before' });
  await a.next(reply);
  a.send({ type: 'detach' });
  await sleep(600);

  a.send({ type: 'list_sessions' });
  const row = (await a.next('sessions')).list.find((r) => r.session === session);
  assert.equal(row.live, false);
  assert.equal(row.state, 'dormant');

  a.send({ type: 'attach', session });
  assert.equal((await a.next('attached')).live, false);
  assert.deepEqual(said((await a.next('history')).messages), ['before', 'echo: before'], 'the log is kept');
  a.send({ type: 'prompt', text: 'after' });
  assert.match(text(await a.next(reply)), /echo: after/);
}, { AGENT_IDLE_STOP_MS: '200', AGENT_SWEEP_MS: '100' });

withService('sessions survive a restart of the service: attach by SDK id replays the transcript', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  await a.next('attached');
  a.send({ type: 'prompt', text: 'remember me' });
  await a.next(reply);
  const sdkId = fs.readdirSync(svc.env.FAKE_DIR)[0].replace('.json', '');
  a.close();

  await svc.restart();
  const b = await svc.connect();
  b.send({ type: 'list_sessions' });
  const row = (await b.next('sessions')).list.find((r) => r.sdkId === sdkId);
  assert.equal(row.summary, 'remember me');
  assert.equal(row.session, null, 'known to the SDK, not yet to this service');

  b.send({ type: 'attach', sdkId });
  const at = await b.next('attached');
  assert.equal(at.sdkId, sdkId);
  const hist = (await b.next('history')).messages;
  assert.deepEqual(said(hist), ['remember me', 'echo: remember me']);
  b.send({ type: 'prompt', text: 'and again' });
  assert.equal(text(await b.next(reply)), `echo: and again (resumed ${sdkId})`);
});

withService('close_session ends it for good and tells the viewers', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  a.send({ type: 'prompt', text: 'x' });
  await a.next(reply);
  a.send({ type: 'close_session', session });
  assert.equal((await a.next('closed')).session, session);
  a.send({ type: 'attach', session });
  assert.match((await a.next('error')).message, /no longer there/);
});

withService('interrupt, bad input and unknown messages do not break the service', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'interrupt' }); // nothing attached
  a.send({ type: 'permission', id: 'nope', allow: true });
  a.send({ type: 'whatever' });
  a.send({ type: 'prompt', text: '   ' });
  a.send({ type: 'attach', session: 'does-not-exist' });
  assert.match((await a.next('error')).message, /no longer there/);
  a.send({ type: 'attach' });
  await a.next('attached');
  a.send({ type: 'prompt', text: 'still fine' });
  assert.equal(text(await a.next(reply)), 'echo: still fine');
});

withService('sign-in works through the service', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'login_start' });
  assert.equal((await a.next('login_url')).url, 'https://example.test/oauth/authorize?code=true&state=abc');
  a.send({ type: 'login_code', code: ' good-code ' });
  assert.deepEqual(await a.next('login_result'), { type: 'login_result', ok: true });
  a.send({ type: 'login_start' });
  await a.next('login_url');
  a.send({ type: 'login_code', code: 'wrong' });
  assert.equal((await a.next('login_result')).ok, false);
});

withService('a client that vanishes with unread data (a connection reset) does not take the service down', async (svc) => {
  const a = await svc.connect();
  a.send({ type: 'attach' });
  const { session } = await a.next('attached');
  a.send({ type: 'prompt', text: 'slow:3000 x' });
  await a.next('session_state');

  // Raw clients that never read and then vanish, as a dropped headset can. Closing with
  // unread data can make the service's next read fail with ECONNRESET; an unhandled error
  // there once took the whole service down. It must log and carry on.
  for (let i = 0; i < 5; i++) {
    const raw = net.connect(svc.env.AGENT_SOCKET);
    raw.on('error', () => {});
    await new Promise((r) => raw.once('connect', r));
    raw.write(JSON.stringify({ type: 'attach', session }) + '\n' + JSON.stringify({ type: 'list_sessions' }) + '\n');
    await sleep(60);
    raw.destroy();
  }
  await sleep(100);
  const b = await svc.connect();
  b.send({ type: 'busy_query' });
  assert.equal((await b.next('busy')).busy, true, 'still serving, and the turn is still running');
  b.send({ type: 'attach', session });
  assert.equal((await b.next('attached')).session, session);
});

test('busy says no when no service is running', () => {
  const svc = sandbox();
  try { assert.equal(svc.busy(), 1); } finally { svc.cleanup(); }
});

test('the socket is private to its owner', async () => {
  const svc = sandbox();
  try {
    await svc.start();
    assert.equal(fs.statSync(svc.env.AGENT_SOCKET).mode & 0o777, 0o600);
    assert.equal(fs.statSync(svc.env.AGENT_STATE_DIR).mode & 0o777, 0o700);
  } finally { svc.cleanup(); }
});

test('a second service finds the first and leaves it alone; a stale socket file is replaced', async () => {
  const svc = sandbox();
  try {
    await svc.start();
    const second = spawnSync(process.execPath, [SERVICE], { env: svc.env, timeout: 5000 });
    assert.equal(second.status, 0);
    const v = await svc.connect(); // the first is still serving
    v.send({ type: 'busy_query' });
    assert.equal((await v.next('busy')).busy, false);
    svc.stop();
    await sleep(200);
    fs.writeFileSync(svc.env.AGENT_SOCKET, ''); // what a crashed service leaves behind
    await svc.start();
    const w = await svc.connect();
    w.send({ type: 'busy_query' });
    assert.equal((await w.next('busy')).busy, false);
  } finally { svc.cleanup(); }
});

test('agent-bridge (attach) starts the service on demand, relays, and leaves it running', async () => {
  const svc = sandbox({ AGENT_SERVICE_PATH: SERVICE });
  try {
    const run = () => {
      const child = spawn(process.execPath, [ATTACH], { env: svc.env, stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = [];
      readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
      return { child, lines, send: (m) => child.stdin.write(JSON.stringify(m) + '\n'), exited: new Promise((r) => child.on('exit', r)) };
    };
    const a = run();
    a.send({ type: 'attach' });
    a.send({ type: 'prompt', text: 'through the relay' });
    for (let i = 0; i < 60 && !a.lines.some((m) => m.type === 'sdk' && m.message.type === 'assistant'); i++) await sleep(100);
    assert.ok(a.lines.some((m) => m.type === 'attached'));
    const answer = a.lines.find((m) => m.type === 'sdk' && m.message.type === 'assistant');
    assert.equal(text(answer), 'echo: through the relay');
    const sessionId = a.lines.find((m) => m.type === 'attached').session;

    a.child.stdin.end(); // the page went away
    await a.exited;
    assert.equal(fs.existsSync(svc.env.AGENT_SOCKET), true, 'the service outlived the relay');

    const b = run(); // a later page finds the same service and the same session
    b.send({ type: 'attach', session: sessionId });
    for (let i = 0; i < 40 && !b.lines.some((m) => m.type === 'history'); i++) await sleep(100);
    assert.deepEqual(said(b.lines.find((m) => m.type === 'history').messages), ['through the relay', 'echo: through the relay']);
    b.child.stdin.end();
    await b.exited;
    const starts = fs.readFileSync(path.join(svc.env.AGENT_STATE_DIR, 'service.log'), 'utf8').split('\n').filter((l) => l.includes('listening on')).length;
    assert.equal(starts, 1, 'one service, started once');
  } finally {
    // The relay started the service detached; end it through its pid file.
    try { process.kill(Number(fs.readFileSync(path.join(svc.env.AGENT_STATE_DIR, 'service.pid'), 'utf8')), 'SIGTERM'); } catch { /* not running */ }
    await sleep(200);
    fs.rmSync(svc.home, { recursive: true, force: true });
  }
});
