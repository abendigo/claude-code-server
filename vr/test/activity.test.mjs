import test from 'node:test';
import assert from 'node:assert/strict';

const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
globalThis.location = { href: 'https://host.example/vr/' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
class FakeWS {
  static OPEN = 1;
  static last = null;
  constructor() { this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send() {} close() {}
  emit(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
globalThis.WebSocket = FakeWS;

const { Conversation } = await import('../client/js/conversation.js');
const { ConversationPanel } = await import('../client/js/conversation-panel.js');
const { ActivityPanel } = await import('../client/js/activity-panel.js');
const { fmtDuration, headerStatus, activityRows } = await import('../client/js/activity.js');
const { init, toolUse, toolResult, result, permissionRequest } = await import('./fixtures.mjs');

const clockAt = () => { const t = { now: 1_000_000 }; t.fn = () => t.now; return t; };
const feed = (c, msgs) => msgs.flat().forEach((m) => c.handle(m));

test('fmtDuration', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(999), '0s');
  assert.equal(fmtDuration(42_000), '42s');
  assert.equal(fmtDuration(72_000), '1m 12s');
  assert.equal(fmtDuration(60_000), '1m 00s');
  assert.equal(fmtDuration(3_723_000), '1h 02m');
  assert.equal(fmtDuration(-5), '0s');
  assert.equal(fmtDuration(null), '');
  assert.equal(fmtDuration(NaN), '');
});

test('the model times each turn and each tool call', () => {
  const t = clockAt();
  const c = new Conversation({ now: t.fn });
  feed(c, [init]);
  c.submit('fix it');
  assert.equal(c.turnStarted, 1_000_000);
  assert.equal(c.turnEnded, null);
  t.now += 2000;
  feed(c, [toolUse('t1', 'Bash', { command: 'npm test', description: 'Run the tests' })]);
  const tool = c.blocks.find((b) => b.kind === 'tool');
  assert.equal(tool.started, 1_002_000);
  assert.equal(tool.ended, null);
  t.now += 5000;
  feed(c, [toolResult('t1', 'ok')]);
  assert.equal(tool.ended, 1_007_000);
  t.now += 1000;
  feed(c, [result()]);
  assert.equal(c.turnEnded, 1_008_000);
});

test('while working the header shows the elapsed time and the running tool', () => {
  const t = clockAt();
  const c = new Conversation({ now: t.fn });
  feed(c, [init]);
  c.setState('idle');
  assert.deepEqual(headerStatus(c, t.now), { tone: 'idle', label: 'Ready', time: '', detail: '' });

  c.submit('go');
  t.now += 3000;
  assert.deepEqual(headerStatus(c, t.now), { tone: 'working', label: 'Working', time: '3s', detail: 'Thinking' });
  feed(c, [toolUse('t1', 'Bash', { command: 'sleep 60', description: 'Wait a minute' })]);
  t.now += 62_000;
  const h = headerStatus(c, t.now);
  assert.equal(h.time, '1m 05s');
  assert.equal(h.detail, 'Wait a minute');

  feed(c, [toolResult('t1', 'done'), result()]);
  assert.equal(headerStatus(c, t.now).detail, 'Last turn took 1m 05s');
  assert.equal(headerStatus(c, t.now).tone, 'idle');
});

test('waiting for approval says so, with what is being asked', () => {
  const t = clockAt();
  const c = new Conversation({ now: t.fn });
  feed(c, [init]);
  c.submit('go');
  c.handle(permissionRequest('p1', 'Bash', { command: 'rm -rf build', description: 'Remove the build folder' }));
  const h = headerStatus(c, t.now + 1000);
  assert.equal(h.tone, 'waiting');
  assert.equal(h.label, 'Needs your answer');
  assert.match(h.detail, /rm -rf build/);
  const rows = activityRows(c, t.now);
  assert.equal(rows.at(-1).kind, 'wait');
  c.answer(true);
  assert.ok(!activityRows(c, t.now).some((r) => r.kind === 'wait'), 'once answered it is no longer waiting');
});

test('offline and connecting', () => {
  const c = new Conversation();
  assert.equal(headerStatus(c, 0).tone, 'offline');
  c.setState('connecting');
  c.status = 'creating environment...';
  assert.deepEqual(headerStatus(c, 0), { tone: 'connecting', label: 'Connecting', time: '', detail: 'creating environment...' });
});

test('rows: what you asked, then each tool with its status and duration', () => {
  const t = clockAt();
  const c = new Conversation({ now: t.fn });
  feed(c, [init]);
  c.submit('please look at the repo\nand fix the thing');
  feed(c, [toolUse('a', 'Read', { file_path: '/w/repo/main.js' })]);
  t.now += 1500;
  feed(c, [toolResult('a', 'x'), toolUse('b', 'Bash', { command: 'false' })]);
  t.now += 4000;
  feed(c, [toolResult('b', 'boom', true), toolUse('c', 'Grep', { pattern: 'foo' })]);
  t.now += 9000;
  const rows = activityRows(c, t.now);
  assert.deepEqual(rows.map((r) => [r.kind, r.status, r.text, r.ms]), [
    ['turn', undefined, 'please look at the repo and fix the thing', undefined],
    ['tool', 'ok', 'Read main.js', 1500],
    ['tool', 'error', 'false', 4000],
    ['tool', 'running', 'Search foo', 9000],
  ]);
});

test('long text is cut to one line, and a long history keeps only the newest rows', () => {
  const c = new Conversation();
  feed(c, [init]);
  c.submit('x'.repeat(500));
  for (let i = 0; i < 300; i++) feed(c, [toolUse(`t${i}`, 'Bash', { command: `echo ${i} ${'y'.repeat(300)}` })]);
  const rows = activityRows(c, Date.now(), { max: 50 });
  assert.equal(rows.length, 50);
  assert.ok(rows.every((r) => r.text.length <= 120));
  assert.ok(rows.at(-1).text.startsWith('echo 299'));
});

test('the main view hides tool cards when asked, and the Activity window listens for changes', () => {
  const make = (showTools) => {
    const p = new ConversationPanel({ agentUrl: '/agent/ws', cwd: '/w', widthM: 1.3, showTools });
    const ws = FakeWS.last;
    ws.emit(init);
    feed(p.convo, [toolUse('a', 'Read', { file_path: '/w/secret-plan.md' })]);
    return p;
  };
  const shown = make(true);
  assert.ok(shown.buildLines(ctx, 1000).some((l) => l.text?.includes('Read secret-plan.md')));
  const hidden = make(false);
  assert.ok(!hidden.buildLines(ctx, 1000).some((l) => l.text?.includes('secret-plan.md')));

  let calls = 0;
  hidden.listeners.add(() => { calls++; });
  feed(hidden.convo, [toolUse('b', 'Bash', { command: 'ls' })]);
  assert.ok(calls >= 1);
});

test('the Activity panel draws every state, scrolls within bounds, and keeps moving while working', () => {
  const t = clockAt();
  const c = new Conversation({ now: t.fn });
  const p = new ActivityPanel({ getConversation: () => c, clock: t.fn });
  p.update(); // offline, nothing yet
  feed(c, [init]);
  c.submit('go');
  for (let i = 0; i < 80; i++) { feed(c, [toolUse(`t${i}`, 'Bash', { command: `step ${i}` })]); if (i % 3) feed(c, [toolResult(`t${i}`, 'ok', i % 7 === 0)]); }
  p.markDirty();
  p.update();

  p.onScroll(-5);
  assert.equal(p.scroll, 0, 'cannot scroll below the newest row');
  p.onScroll(1e6);
  p.update();
  const top = p.scroll;
  assert.ok(top > 0 && top < 1e6 * 40, 'clamped at the oldest row');
  p.onScroll(-1e6);
  assert.equal(p.scroll, 0);

  // Working: not dirty right after a draw, dirty again once the redraw interval has passed.
  p.update();
  p.dirty = false;
  p.update();
  assert.equal(p.dirty, false);
  t.now += 250;
  p.update();
  assert.equal(p.lastDraw, t.now, 'it redrew by itself');

  // Idle: it stops redrawing by itself.
  feed(c, [result()]);
  p.update();
  const before = p.lastDraw;
  t.now += 5000;
  p.update();
  assert.equal(p.lastDraw, before);
});

test('with no conversation yet the panel draws without failing', () => {
  const p = new ActivityPanel({ getConversation: () => null });
  assert.doesNotThrow(() => { p.update(); p.onScroll(3); p.update(); });
});
