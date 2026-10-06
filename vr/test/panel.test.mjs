// ConversationPanel and its voice integration, with a stub canvas and a fake
// websocket: no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- browser stubs (must exist before the modules are imported) ----------------
const drawn = [];
const ctx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : k === 'fillText' ? (s) => drawn.push(String(s)) : () => {}),
  set: () => true,
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
globalThis.location = { href: 'https://host.example/vr/' };
const storage = {};
globalThis.localStorage = { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };
class FakeWS {
  static OPEN = 1;
  static last = null;
  constructor(url) { this.url = String(url); this.sent = []; this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeWS;

const { ConversationPanel } = await import('../client/js/conversation-panel.js');
const { VoicePanel } = await import('../client/js/voice-panel.js');
const { init, reply, toolUse, toolResult, result, permissionRequest } = await import('./fixtures.mjs');
const tick = () => new Promise((r) => setTimeout(r, 5));

async function make(opts = {}) {
  for (const k of Object.keys(storage)) delete storage[k];
  const p = new ConversationPanel({ agentUrl: '/agent/ws', cwd: '/workspace/proj', ...opts });
  await tick();
  return { p, ws: FakeWS.last };
}
const draw = (p) => { drawn.length = 0; p.draw(ctx, p.pxW, p.pxH); return drawn.join('\n'); };
// Draw, find the button with this label, and click its centre.
function clickByText(p, text) {
  draw(p);
  const spot = p.spots.find((s) => s.label === text);
  assert.ok(spot, `"${text}" should be clickable`);
  p.onClick({ u: (spot.x + spot.w / 2) / p.pxW, v: (spot.y + spot.h / 2) / p.pxH });
}

test('connects to the agent url and starts idle', async () => {
  const { p, ws } = await make();
  assert.match(ws.url, /^wss:\/\/host\.example\/agent\/ws$/);
  assert.equal(p.convo.state, 'idle');
});

test('typing and Enter sends a prompt with the working directory; input clears', async () => {
  const { p, ws } = await make();
  for (const ch of 'hi there') p.send(ch);
  p.send('\x7f'); // backspace
  p.send('\r');
  assert.deepEqual(ws.sent, [{ type: 'prompt', text: 'hi ther', cwd: '/workspace/proj' }]);
  assert.equal(p.input, '');
  assert.equal(p.convo.state, 'working');
});

test('paste fills the input without sending; Escape clears it', async () => {
  const { p, ws } = await make();
  p.paste('some dictated text');
  assert.equal(p.input, 'some dictated text');
  assert.equal(ws.sent.length, 0);
  p.send('\x1b');
  assert.equal(p.input, '');
});

test('permission card shows Allow / Always allow / Deny and clicking Allow answers', async () => {
  const { p, ws } = await make();
  p.submit('touch a file');
  [init, ...toolUse('t1', 'Bash', { command: 'touch x', description: 'Create x' }), permissionRequest('p1', 'Bash', { command: 'touch x', description: 'Create x' })].forEach((m) => ws.emit(m));
  const text = draw(p);
  assert.match(text, /Claude wants to:/);
  assert.match(text, /touch x/);
  for (const label of ['Allow', 'Always allow', 'Deny']) assert.ok(text.includes(label), label);
  ws.sent.length = 0;
  clickByText(p, 'Allow');
  assert.deepEqual(ws.sent, [{ type: 'permission', id: 'p1', allow: true, always: false }]);
  assert.equal(p.convo.state, 'working');
});

test('Deny and Always allow send the right answers', async () => {
  for (const [label, want] of [['Deny', { allow: false, always: false }], ['Always allow', { allow: true, always: true }]]) {
    const { p, ws } = await make();
    p.submit('x');
    ws.emit(permissionRequest('p9', 'Bash', { command: 'rm y' }));
    ws.sent.length = 0;
    clickByText(p, label);
    assert.deepEqual(ws.sent, [{ type: 'permission', id: 'p9', ...want }]);
  }
});

test('cannot send a new message while an approval is pending, and says why', async () => {
  const { p, ws } = await make();
  p.submit('first');
  ws.emit(permissionRequest('p1', 'Bash', { command: 'x' }));
  ws.sent.length = 0;
  p.paste('second');
  p.send('\r');
  assert.equal(ws.sent.length, 0);
  assert.match(p.convo.blocks.at(-1).text, /Answer the approval first/);
});

test('conversation renders messages, tool cards and streaming text', async () => {
  const { p, ws } = await make();
  p.submit('do the thing');
  [init, ...reply('a1', 'Sure, I will do it'), ...toolUse('t1', 'Bash', { command: 'ls', description: 'List files' }), toolResult('t1', 'a b'), result()].forEach((m) => ws.emit(m));
  const text = draw(p);
  assert.match(text, /do the thing/);
  assert.match(text, /Sure, I will do it/);
  assert.match(text, /List files/);
  assert.equal(p.lines.find((l) => l.text === 'List files')?.mark, 'ok'); // drawn as a shape, not a font glyph
  assert.match(text, /ready/);
});

test('scrolling up shows the "newer below" hint and ▼ returns to the bottom', async () => {
  const { p, ws } = await make();
  for (let i = 0; i < 40; i++) [...reply('a' + i, `Line number ${i} of a long answer`)].forEach((m) => ws.emit(m));
  assert.doesNotMatch(draw(p), /newer below/);
  p.onScroll(10);
  assert.ok(p.scroll > 0);
  assert.match(draw(p), /newer below/);
  clickByText(p, '▼');
  assert.equal(p.scroll, 0);
});

test('session id is remembered; Resume sends it with the first prompt only', async () => {
  const { p, ws } = await make();
  ws.emit(init);
  assert.equal(storage['vr.agent.session'], 'sess-1');
  p.resume();
  const ws2 = FakeWS.last;
  await tick();
  p.submit('continue please');
  p.submit('and again');
  assert.deepEqual(ws2.sent.map((m) => m.resume), ['sess-1', undefined]);
});

test('New clears the remembered session', async () => {
  const { p, ws } = await make();
  ws.emit(init);
  p.newConversation();
  assert.equal(storage['vr.agent.session'], undefined);
});

// ---- voice -> conversation --------------------------------------------------------
function voiceFor(panel, spoken) {
  const voice = { ready: true, start: () => true, stop: async () => new Blob([new Uint8Array(5000)]), transcribe: async () => ({ text: spoken, ms: 10 }) };
  const vp = new VoicePanel({ voice, getTarget: () => panel, sttEnabled: true });
  return vp;
}
async function dictate(vp) {
  vp.startRecording();
  await vp.stopRecording();
}

test('saying "yes" while an approval is pending answers it (and is not sent as a message)', async () => {
  const { p, ws } = await make();
  p.submit('x');
  ws.emit(permissionRequest('p1', 'Bash', { command: 'touch x' }));
  ws.sent.length = 0;
  await dictate(voiceFor(p, 'Yes.'));
  assert.deepEqual(ws.sent, [{ type: 'permission', id: 'p1', allow: true, always: false }]);
});

test('"always allow" and "no" map correctly', async () => {
  for (const [said, want] of [['Always allow', { allow: true, always: true }], ['No.', { allow: false, always: false }]]) {
    const { p, ws } = await make();
    p.submit('x');
    ws.emit(permissionRequest('p1', 'Bash', { command: 'touch x' }));
    ws.sent.length = 0;
    await dictate(voiceFor(p, said));
    assert.deepEqual(ws.sent, [{ type: 'permission', id: 'p1', ...want }]);
  }
});

test('a sentence containing "yes" during an approval goes to review, not auto-approve', async () => {
  const { p, ws } = await make();
  p.submit('x');
  ws.emit(permissionRequest('p1', 'Bash', { command: 'touch x' }));
  ws.sent.length = 0;
  const vp = voiceFor(p, 'Yes but only inside the tests folder');
  await dictate(vp);
  assert.equal(ws.sent.length, 0);
  assert.equal(vp.state, 'review');
});

test('dictation to a conversation is sent as soon as you stop talking (no Send tap), in prose style', async () => {
  const { p, ws } = await make();
  const vp = voiceFor(p, 'Please run the tests.');
  assert.equal(vp.isDirect(), true); // the default for a conversation
  vp.mode = 'command'; // would lowercase and strip the period for a terminal
  await dictate(vp);
  assert.deepEqual(ws.sent.map((m) => [m.type, m.text]), [['prompt', 'Please run the tests.']]);
});

test('a terminal still defaults to Review, and the two preferences are independent', async () => {
  const term = { name: 't', paste() {}, send() {} }; // no voiceSubmits: a terminal
  const vp = new VoicePanel({ voice: { ready: true }, getTarget: () => term, sttEnabled: true });
  assert.equal(vp.isDirect(), false);
  vp.toggleDirect();
  assert.equal(vp.isDirect(), true);
  assert.equal(vp.directChat, true); // untouched
  assert.equal(storage['vr.voice.direct'], '1');
});

test('with "After: Review" chosen, dictation to a conversation waits for Send', async () => {
  const { p, ws } = await make();
  const vp = voiceFor(p, 'Fix the failing test');
  vp.toggleDirect(); // conversation default is Send; this switches it to Review
  assert.equal(vp.isDirect(), false);
  assert.equal(storage['vr.voice.directChat'], '0');
  await dictate(vp);
  assert.equal(vp.state, 'review');
  vp.confirm(false);
  assert.deepEqual(ws.sent.map((m) => m.text), ['Fix the failing test']);
});

test('voice bar has a Tools button that reflects and flips the tool group', async () => {
  const { p } = await make();
  const vp = voiceFor(p, 'x');
  assert.ok(!vp.buttons().some((b) => b.label.startsWith('Tools')), 'no button until a group is attached');
  let visible = false;
  vp.toolGroup = { get visible() { return visible; }, toggle() { visible = !visible; } };
  const btn = () => vp.buttons().find((b) => b.label.startsWith('Tools'));
  assert.equal(btn().label, 'Tools: Off');
  btn().act();
  assert.equal(btn().label, 'Tools: On');
  const r = btn(); // clicking its centre works through the normal hit-testing
  vp.onClick({ u: (r.x + r.w / 2) / vp.pxW, v: (r.y + r.h / 2) / vp.pxH });
  assert.equal(visible, false);
});

// ---- spoken replies ----------------------------------------------------------------------
function fakeSpeaker() {
  const s = { said: [], stops: 0, speaking: false, available: true, enabled: true, say(t) { this.said.push(t); }, stop() { this.stops++; }, toggle() { this.enabled = !this.enabled; } };
  return s;
}

test('Claude\'s summary is spoken when the turn ends, and the Speak button toggles it', async () => {
  const speaker = fakeSpeaker();
  const { p, ws } = await make({ speaker });
  p.submit('hello');
  ws.emit(init);
  for (const m of reply('a1', 'Done. <spoken>All finished.</spoken>')) ws.emit(m);
  ws.emit(result());
  assert.deepEqual(speaker.said, ['All finished.']);
  assert.ok(!draw(p).includes('<spoken>'));
  assert.ok(draw(p).includes('Speak: On'));
  clickByText(p, 'Speak: On');
  assert.equal(speaker.enabled, false);
});

test('sending, answering, stopping and starting over all silence speech; Hush shows while speaking', async () => {
  const speaker = fakeSpeaker();
  const { p, ws } = await make({ speaker });
  p.submit('go');
  assert.equal(speaker.stops, 1);
  ws.emit(init);
  ws.emit(permissionRequest('p1', 'Bash', { command: 'touch x' }));
  assert.deepEqual(speaker.said, ['Claude wants to run a command. Say yes or no.']);
  p.answerPermission('allow');
  assert.equal(speaker.stops, 2);
  speaker.speaking = true;
  clickByText(p, 'Hush');
  assert.equal(speaker.stops, 3);
  speaker.speaking = false;
  p.newConversation();
  assert.equal(speaker.stops, 4);
});

test('starting to record silences speech', () => {
  const speaker = fakeSpeaker();
  const voice = { ready: true, start: () => true, stop() {} };
  const vp = new VoicePanel({ voice, getTarget: () => null, sttEnabled: true, speaker });
  vp.startRecording();
  assert.equal(speaker.stops, 1);
});

test('with no speech engine the header says so instead of hiding the button', async () => {
  const speaker = { ...fakeSpeaker(), available: false };
  const { p } = await make({ speaker });
  assert.ok(draw(p).includes('Speak: n/a'));
  clickByText(p, 'Speak: n/a');
  assert.match(p.convo.blocks.at(-1).text, /no speech engine/);
});
