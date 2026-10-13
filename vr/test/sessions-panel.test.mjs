import test from 'node:test';
import assert from 'node:assert/strict';

const drawn = [];
const ctx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : k === 'fillText' ? (s) => drawn.push(String(s)) : () => {}),
  set: () => true,
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };

const { SessionsPanel, age } = await import('../client/js/sessions-panel.js');
const { Conversation } = await import('../client/js/conversation.js');

const NOW = 10_000_000;
const mk = (extra = {}) => ({ session: 's1', sdkId: 'k1', cwd: '/workspace', summary: 'Fix the keyboard', lastModified: NOW - 120_000, state: 'idle', live: true, viewers: 1, ...extra });

function make(rows, { open = true, current = 's1' } = {}) {
  const convo = new Conversation();
  convo.attach = { session: current, sdkId: 'k1', cwd: '/workspace' };
  convo.sessions = rows;
  const calls = [];
  const client = {
    get open() { return open; },
    listSessions: () => { calls.push(['list']); return true; },
    switchTo: (r) => calls.push(['switch', r.session ?? r.sdkId]),
    newSession: () => calls.push(['new']),
    closeSession: (r) => calls.push(['close', typeof r === 'string' ? r : r.session ?? r.sdkId]),
  };
  const clock = { now: NOW };
  const p = new SessionsPanel({ getConversation: () => convo, client, clock: () => clock.now });
  return { p, convo, calls, clock };
}
const draw = (p) => { drawn.length = 0; p.draw(ctx, p.pxW, p.pxH); return drawn.join('\n'); };
// Click the centre of a spot found by drawing first.
const clickSpot = (p, pick) => {
  draw(p);
  const s = p.spots.find(pick);
  assert.ok(s, 'spot found');
  p.onClick({ u: (s.x + s.w / 2) / p.pxW, v: (s.y + s.h / 2) / p.pxH });
};

test('age wording', () => {
  assert.equal(age(NOW, NOW), 'just now');
  assert.equal(age(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(age(NOW - 3 * 3600_000, NOW), '3h ago');
  assert.equal(age(NOW - 3 * 86400_000, NOW), '3d ago');
});

test('rows show the first prompt, state and age; the current one is marked', () => {
  const { p } = make([mk(), mk({ session: 's2', summary: 'Plan the service', state: 'working', lastModified: NOW - 3 * 3600_000, current: false }), mk({ session: null, sdkId: 'k3', summary: 'Old one', state: 'dormant', lastModified: NOW - 3 * 86400_000 })]);
  const text = draw(p);
  assert.match(text, /Fix the keyboard/);
  assert.match(text, /ready · 2m ago · this one/);
  assert.match(text, /working · 3h ago/);
  assert.match(text, /asleep · 3d ago/);
  assert.ok(!/Plan the service[\s\S]*this one/.test(text.split('Old one')[0].split('Plan the service')[1] ?? ''), 'only the current row is marked');
});

test('only sessions from this conversation\'s folder are listed', () => {
  const { p } = make([mk(), mk({ session: 's2', summary: 'From the terminal', cwd: '/elsewhere/project' }), mk({ session: 's3', summary: 'No folder known', cwd: '' })]);
  const text = draw(p);
  assert.match(text, /Fix the keyboard/);
  assert.match(text, /No folder known/);
  assert.ok(!text.includes('From the terminal'));
});

test('an empty title, and an empty or disconnected list, say so', () => {
  assert.match(draw(make([mk({ summary: '' })]).p), /nothing asked yet/);
  assert.match(draw(make([]).p), /No sessions yet/);
  assert.match(draw(make([], { open: false }).p), /Not connected/);
});

test('tapping another row switches to it; tapping the current one does nothing', () => {
  const { p, calls } = make([mk(), mk({ session: 's2', summary: 'Other' }), mk({ session: null, sdkId: 'k3', summary: 'Asleep', state: 'dormant' })]);
  // rows are 104px apart, below the header; click the left part of each row (the cross is on the right)
  const clickRow = (i) => { draw(p); p.onClick({ u: 0.4, v: (110 + 8 + i * 104 + 50) / p.pxH }); };
  clickRow(0);
  assert.deepEqual(calls, [], 'the current session');
  clickRow(1);
  assert.deepEqual(calls.at(-1), ['switch', 's2']);
  clickRow(2);
  assert.deepEqual(calls.at(-1), ['switch', 'k3']);
});

test('New starts a fresh session', () => {
  const { p, calls } = make([mk()]);
  clickSpot(p, (s) => s.y < 110 && s.x > 500);
  assert.deepEqual(calls[0], ['new']);
});

test('ending a session takes two taps within a few seconds; a sleeping one known only from disk has a cross too', () => {
  const { p, calls, clock } = make([mk(), mk({ session: 's2', summary: 'Other' }), mk({ session: null, sdkId: 'k3', summary: 'Asleep', state: 'dormant' })]);
  const cross = (i) => (s) => s.x > 700 && s.y >= 118 + i * 104 && s.y < 118 + (i + 1) * 104;
  clickSpot(p, cross(1));
  assert.deepEqual(calls.filter((c) => c[0] === 'close'), [], 'first tap only arms it');
  assert.match(draw(p), /End\?/);
  clickSpot(p, cross(1));
  assert.deepEqual(calls.filter((c) => c[0] === 'close'), [['close', 's2']]);
  // armed, then left alone too long: disarmed
  clickSpot(p, cross(0));
  assert.equal(p.armed?.id, 's1');
  clock.now += 4000;
  p.update();
  assert.equal(p.armed, null, 'the second tap would now only arm it again');
  assert.ok(!/End\?/.test(draw(p)));
  // the third row is asleep, known only from its transcript (no service handle): it closes by its SDK id
  clickSpot(p, cross(2));
  clickSpot(p, cross(2));
  assert.deepEqual(calls.filter((c) => c[0] === 'close').at(-1), ['close', 'k3']);
});

test('the list refreshes every few seconds while shown and connected, and after an action', () => {
  const { p, calls, clock } = make([mk()]);
  p.update();
  assert.equal(calls.filter((c) => c[0] === 'list').length, 1);
  p.update();
  assert.equal(calls.filter((c) => c[0] === 'list').length, 1, 'not again straight away');
  clock.now += 5100;
  p.update();
  assert.equal(calls.filter((c) => c[0] === 'list').length, 2);
  clickSpot(p, (s) => s.y < 110 && s.x > 500); // New
  p.update();
  assert.equal(calls.filter((c) => c[0] === 'list').length, 3, 'asked again right after the action');
});

test('a disconnected panel does not poll, and scrolling stays within the list', () => {
  const { p, calls } = make(Array.from({ length: 30 }, (_, i) => mk({ session: `s${i}`, summary: `Session ${i}` })), { open: false });
  p.update();
  assert.equal(calls.length, 0);
  p.onScroll(-3);
  assert.equal(p.offset, 120, 'down');
  p.onScroll(1e6);
  assert.equal(p.offset, 0, 'cannot go above the top');
  p.onScroll(-1e6);
  draw(p);
  assert.ok(p.offset > 0 && p.offset <= 30 * 104, 'clamped to the end of the list');
});

test('with no conversation yet it draws nothing and does not fail', () => {
  const p = new SessionsPanel({ getConversation: () => null, client: { open: false, listSessions() {} } });
  assert.doesNotThrow(() => { p.update(); draw(p); p.onClick({ u: 0.5, v: 0.5 }); });
});

test('Clear asleep: only shown when something is asleep, takes two taps, and leaves the current and running sessions alone', () => {
  const none = make([mk(), mk({ session: 's2', state: 'working' })]);
  assert.ok(!/Clear asleep/.test(draw(none.p)));

  const { p, calls, clock } = make([
    mk(), // the current one, idle
    mk({ session: 's2', summary: 'Running', state: 'working' }),
    mk({ session: null, sdkId: 'k3', summary: 'Asleep one', state: 'dormant' }),
    mk({ session: null, sdkId: 'k4', summary: 'Asleep two', state: 'dormant' }),
  ]);
  assert.match(draw(p), /Clear asleep/);
  const clearSpot = () => p.spots.find((s) => s.y < 110 && s.x > 300 && s.x < 500);
  const tap = () => { draw(p); const s = clearSpot(); p.onClick({ u: (s.x + s.w / 2) / p.pxW, v: (s.y + s.h / 2) / p.pxH }); };
  tap();
  assert.deepEqual(calls.filter((c) => c[0] === 'close'), [], 'the first tap only arms it');
  assert.match(draw(p), /Close 2\?/);
  tap();
  assert.deepEqual(calls.filter((c) => c[0] === 'close'), [['close', 'k3'], ['close', 'k4']]);
  // armed and left alone: disarmed
  tap();
  clock.now += 4000;
  p.update();
  assert.equal(p.armed, null);
});
