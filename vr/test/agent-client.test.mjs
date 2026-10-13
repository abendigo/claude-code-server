// AgentClient: choosing what to attach to, falling back, and reconnecting.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { href: 'https://host.example/vr/' };
class FakeWS {
  static OPEN = 1;
  static all = [];
  constructor(url) { this.url = String(url); this.sent = []; this.readyState = 1; FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.onclose?.(); } // the connection vanishes
}
globalThis.WebSocket = FakeWS;

const { AgentClient } = await import('../client/js/agent-client.js');
const { Conversation } = await import('../client/js/conversation.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memoryStore(initial = {}) {
  const s = { v: { ...initial }, read() { return { ...this.v }; }, write(x) { this.v = { ...x }; }, clear() { this.v = {}; } };
  return s;
}
async function make(storeInit, opts = {}) {
  FakeWS.all.length = 0;
  const convo = new Conversation();
  const store = memoryStore(storeInit);
  const client = new AgentClient('/agent/ws', convo, { cwd: '/workspace', store, attachTimeoutMs: 40, backoffMs: [20, 40, 80], ...opts });
  client.connect();
  await sleep(5);
  return { client, convo, store, ws: () => FakeWS.all.at(-1) };
}
const types = (ws) => ws.sent.map((m) => m.type);
const attached = (session = 'svc1', sdkId = 'sdk1', state = 'idle') => ({ type: 'attached', session, sdkId, cwd: '/workspace', state, live: true });

test('a remembered service session is attached to, and remembered again once attached', async () => {
  const { ws, store, convo, client } = await make({ svc: 'svc1', sdk: 'sdk1' });
  assert.deepEqual(ws().sent, [{ type: 'attach', session: 'svc1', cwd: '/workspace' }]);
  ws().emit(attached('svc1', 'sdk1', 'working'));
  assert.equal(client.attached, true);
  assert.equal(client.legacy, false);
  assert.deepEqual(store.v, { svc: 'svc1', sdk: 'sdk1' });
  assert.equal(convo.state, 'working');
});

test('if the service forgot the session, the SDK id is tried, then the newest session', async () => {
  const { ws } = await make({ svc: 'gone', sdk: 'sdk1' });
  ws().emit({ type: 'error', message: 'That session is no longer there.' });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', sdkId: 'sdk1', cwd: '/workspace' });
  ws().emit({ type: 'error', message: 'That session has ended.' });
  assert.equal(ws().sent.at(-1).type, 'list_sessions');
  ws().emit({ type: 'sessions', list: [{ session: 'svc9', sdkId: 'sdk9', cwd: '/workspace', state: 'idle' }, { session: 'svc8', sdkId: 'sdk8', cwd: '/workspace', state: 'idle' }] });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', session: 'svc9', cwd: '/workspace' });
});

test('nothing remembered: attach to the newest session in this folder, a dormant one by SDK id', async () => {
  const { ws, convo } = await make({});
  assert.deepEqual(types(ws()), ['list_sessions']);
  ws().emit({ type: 'sessions', list: [
    { session: null, sdkId: 'terminal-1', cwd: '/elsewhere', state: 'dormant' },
    { session: null, sdkId: 'old-1', cwd: '/workspace', state: 'dormant' },
  ] });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', sdkId: 'old-1', cwd: '/workspace' });
  assert.equal(convo.sessions.length, 2, 'the list also reaches the model');
});

test('nothing remembered and nothing in this folder: a new session', async () => {
  const { ws } = await make({});
  ws().emit({ type: 'sessions', list: [{ session: 'x', cwd: '/elsewhere', state: 'idle' }] });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', cwd: '/workspace' });
  const { ws: ws2 } = await make({});
  ws2().emit({ type: 'sessions', list: [] });
  assert.deepEqual(ws2().sent.at(-1), { type: 'attach', cwd: '/workspace' });
});

test('no answer to attach means an old worker: fall back to one session per connection', async () => {
  const { client } = await make({ svc: 'svc1' });
  assert.equal(client.legacy, false);
  await sleep(80);
  assert.equal(client.legacy, true);
  const late = await make({ svc: 'svc1' });
  late.ws().emit(attached());
  await sleep(80);
  assert.equal(late.client.legacy, false, 'an answer in time cancels the fallback');
});

test('a dropped connection reconnects by itself to the same session, keeping the screen meanwhile', async () => {
  const { ws, convo, client, store } = await make({ svc: 'svc1', sdk: 'sdk1' });
  ws().emit(attached());
  ws().emit({ type: 'history', messages: [{ type: 'user_prompt', text: 'hello', at: 1 }] });
  const first = ws();
  first.drop();
  assert.equal(convo.state, 'connecting');
  assert.equal(convo.status, 'Reconnecting…');
  assert.equal(convo.blocks.length, 1, 'the conversation stays on screen while reconnecting');
  await sleep(60);
  assert.equal(FakeWS.all.length, 2);
  assert.deepEqual(ws().sent[0], { type: 'attach', session: 'svc1', cwd: '/workspace' });
  assert.deepEqual(store.v, { svc: 'svc1', sdk: 'sdk1' });
  ws().emit(attached());
  assert.equal(client.attach === undefined, true);
  assert.equal(convo.state, 'idle');
});

test('reconnecting backs off while the service keeps dropping us, and a real attach resets the wait', async () => {
  const { ws } = await make({ svc: 'svc1' }, { backoffMs: [20, 60] });
  ws().drop();
  await sleep(35);
  assert.equal(FakeWS.all.length, 2);
  ws().drop(); // dropped again before attaching: the second wait is longer
  await sleep(35);
  assert.equal(FakeWS.all.length, 2, 'still waiting');
  await sleep(50);
  assert.equal(FakeWS.all.length, 3);
  ws().emit(attached());
  ws().drop(); // it had attached, so the wait starts over
  await sleep(35);
  assert.equal(FakeWS.all.length, 4);
});

test('closing on purpose does not reconnect', async () => {
  const { client } = await make({ svc: 'svc1' });
  client.close();
  await sleep(80);
  assert.equal(FakeWS.all.length, 1);
});

test('New attaches to a fresh session without reconnecting and forgets the old one', async () => {
  const { ws, client, store } = await make({ svc: 'svc1', sdk: 'sdk1' });
  ws().emit(attached());
  client.newSession();
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', cwd: '/workspace' });
  assert.deepEqual(store.v, {});
  assert.equal(FakeWS.all.length, 1);
  ws().emit(attached('svc2', 'sdk2'));
  assert.deepEqual(store.v, { svc: 'svc2', sdk: 'sdk2' });
});

test('switching, closing and listing send the right messages; not connected says so', async () => {
  const { ws, client, convo } = await make({ svc: 'svc1' });
  ws().emit(attached());
  client.switchTo({ session: 'svc3' });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', session: 'svc3', cwd: '/workspace' });
  client.switchTo({ session: null, sdkId: 'sdk7' });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', sdkId: 'sdk7', cwd: '/workspace' });
  client.closeSession('svc3');
  assert.deepEqual(ws().sent.at(-1), { type: 'close_session', session: 'svc3' });
  assert.equal(client.listSessions(), true);
  ws().drop();
  convo.blocks.length = 0;
  assert.equal(client.listSessions(), false, 'listing while disconnected is silent');
  assert.equal(convo.blocks.length, 0);
  assert.equal(client.closeSession('x'), false);
  assert.match(convo.blocks.at(-1).text, /Reconnecting/);
});

test('closing a session: by the service\'s id, or by SDK id for one known only from disk', async () => {
  const { ws, client } = await make({ svc: 'svc1' });
  ws().emit(attached());
  client.closeSession('svc3');
  assert.deepEqual(ws().sent.at(-1), { type: 'close_session', session: 'svc3' });
  client.closeSession({ session: 'svc4', sdkId: 'k4' });
  assert.deepEqual(ws().sent.at(-1), { type: 'close_session', session: 'svc4', sdkId: 'k4' });
  client.closeSession({ session: null, sdkId: 'k9' });
  assert.deepEqual(ws().sent.at(-1), { type: 'close_session', sdkId: 'k9' });
});

test('when the session being followed is closed, the page moves on to the newest, or a new one', async () => {
  const { ws, client, store } = await make({ svc: 'svc1', sdk: 'sdk1' });
  ws().emit(attached('svc1', 'sdk1'));
  ws().emit({ type: 'closed', session: 'someone-else' });
  assert.equal(client.attached, true, 'another session closing is none of our business');
  ws().emit({ type: 'closed', session: 'svc1' });
  assert.equal(client.attached, false);
  assert.deepEqual(store.v, {}, 'forgotten, so a reload does not try to go back');
  assert.equal(ws().sent.at(-1).type, 'list_sessions');
  ws().emit({ type: 'sessions', list: [{ session: 'svc9', sdkId: 'sdk9', cwd: '/workspace', state: 'idle' }] });
  assert.deepEqual(ws().sent.at(-1), { type: 'attach', session: 'svc9', cwd: '/workspace' });
});
