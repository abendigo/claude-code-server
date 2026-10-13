// The Workers section of the VR Activity window: what it shows, and the two-tap Stop.
import test from 'node:test';
import assert from 'node:assert/strict';

const drawn = [];
const ctx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : k === 'fillText' ? (s) => drawn.push(String(s)) : () => {}),
  set: () => true,
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };

const { ActivityPanel } = await import('../client/js/activity-panel.js');
const { Conversation } = await import('../client/js/conversation.js');

const NOW = 5_000_000;
const task = (extra = {}) => ({ id: 'w1', description: 'Run the tests', status: 'running', startedAt: NOW - 90_000, endedAt: null, last: 'Bash', summary: '', ...extra });

function make(tasks, { client = true } = {}) {
  const convo = new Conversation({ now: () => NOW });
  convo.handle({ type: 'attached', session: 'svc1', sdkId: 'k1', cwd: '/w', state: 'idle', tasks });
  const stops = [];
  const clock = { now: NOW };
  const p = new ActivityPanel({ getConversation: () => convo, clock: () => clock.now, client: client ? { stopTask: (id) => stops.push(id) } : null });
  return { p, convo, stops, clock };
}
const draw = (p) => { drawn.length = 0; p.draw(ctx, p.pxW, p.pxH); return drawn.join('\n'); };
const tapStop = (p) => {
  draw(p);
  const s = p.spots[0];
  assert.ok(s, 'a Stop button');
  p.onClick({ u: (s.x + s.w / 2) / p.pxW, v: (s.y + s.h / 2) / p.pxH });
};

test('running and finished workers are listed with time and what they are doing', () => {
  const { p } = make([task(), task({ id: 'w2', description: 'Lint everything', status: 'completed', endedAt: NOW - 30_000, startedAt: NOW - 60_000, summary: 'Lint passed' })]);
  const text = draw(p);
  assert.match(text, /WORKERS/);
  assert.match(text, /Run the tests/);
  assert.match(text, /1m 30s/);
  assert.match(text, /using Bash/);
  assert.match(text, /Lint everything/);
  assert.match(text, /Lint passed/);
  assert.match(text, /30s/);
  assert.match(text, /1 worker running/, 'the status line says so, and still says Ready');
  assert.match(text, /Ready/);
});

test('no workers, no section; a failed or stopped worker shows its status', () => {
  assert.ok(!/WORKERS/.test(draw(make([]).p)));
  const text = draw(make([task({ status: 'stopped', endedAt: NOW - 1000 }), task({ id: 'w3', description: 'Build', status: 'failed', endedAt: NOW - 2000 })]).p);
  assert.match(text, /stopped/);
  assert.match(text, /failed/);
});

test('Stop takes two taps; the first only arms it', () => {
  const { p, stops } = make([task()]);
  tapStop(p);
  assert.deepEqual(stops, []);
  assert.match(draw(p), /Stop\?/);
  tapStop(p);
  assert.deepEqual(stops, ['w1']);
});

test('an armed Stop that is left alone disarms itself', () => {
  const { p, stops, clock } = make([task()]);
  tapStop(p);
  clock.now += 4000;
  p.update();
  assert.equal(p.armed, null);
  tapStop(p); // arms again rather than stopping
  assert.deepEqual(stops, []);
});

test('only a running worker has Stop, and not at all without a way to stop', () => {
  const finished = make([task({ status: 'completed', endedAt: NOW - 1000 })]);
  draw(finished.p);
  assert.equal(finished.p.spots.length, 0);
  const noClient = make([task()], { client: false });
  assert.ok(!/Stop/.test(draw(noClient.p)));
});

test('the window keeps redrawing while a worker runs, even though the session is idle', () => {
  const { p, clock } = make([task()]);
  p.update();
  const first = p.lastDraw;
  clock.now += 250;
  p.update();
  assert.ok(p.lastDraw > first, 'the worker timer moves');
  const idle = make([task({ status: 'completed', endedAt: NOW - 1 })]);
  idle.p.update();
  const before = idle.p.lastDraw;
  idle.clock.now += 5000;
  idle.p.update();
  assert.equal(idle.p.lastDraw, before, 'and stops when nothing is running');
});

test('many workers are capped with a count of the rest', () => {
  const many = Array.from({ length: 9 }, (_, i) => task({ id: `w${i}`, description: `Job ${i}` }));
  const text = draw(make(many).p);
  assert.match(text, /\+3 more/);
  assert.ok(!text.includes('Job 8'));
});
