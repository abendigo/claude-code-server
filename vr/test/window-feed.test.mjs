import test from 'node:test';
import assert from 'node:assert/strict';

const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { WindowFeed, validEntries } = await import('../client/js/window-feed.js');
const { WindowManager } = await import('../client/js/windows.js');
const { MarkdownPanel } = await import('../client/js/markdown-panel.js');
const THREE = await import('three');

// A fake hub folder: path -> text (or a status number for an error).
const hub = (files) => async (url) => {
  const v = files[url];
  if (typeof v === 'number') return { ok: false, status: v };
  if (v === undefined) return { ok: false, status: 404 };
  if (v instanceof Error) throw v;
  return { ok: true, status: 200, json: async () => JSON.parse(v), text: async () => v };
};
const manifest = (...windows) => JSON.stringify({ windows });

const recorder = (files) => {
  const log = [];
  const feed = new WindowFeed({
    fetchFn: hub(files),
    open: (e, text) => log.push(['open', e.id, e.title, text]),
    update: (e, text) => log.push(['update', e.id, text]),
    close: (id) => log.push(['close', id]),
  });
  return { feed, log, files };
};

test('validEntries keeps good entries and drops bad ones', () => {
  const ok = validEntries({ windows: [
    { id: 'a', path: 'docs/a.md' },
    { id: 'b', markdown: '# hi', title: 'Bee' },
    { id: 'a', path: 'docs/dup.md' }, // duplicate id
    { id: 'c', path: '../secret.md' },
    { id: 'd', path: '/etc/passwd' },
    { id: 'e', path: 'https://evil.example/x.md' },
    { id: 'f', path: 'a/../../b.md' },
    { id: 'bad id', markdown: 'x' },
    { id: 'g' }, // nothing to show
    null, 'str', 5,
  ] });
  assert.deepEqual(ok.map((e) => e.id), ['a', 'b']);
  assert.equal(ok[0].title, 'a', 'title defaults to the id');
  assert.equal(ok[1].title, 'Bee');
  assert.deepEqual(validEntries(null), []);
  assert.deepEqual(validEntries({ windows: 'nope' }), []);
});

test('a new id opens, an unchanged poll does nothing, a changed file updates', async () => {
  const { feed, log, files } = recorder({ 'windows.json': manifest({ id: 'h', title: 'Handoff', path: 'docs/h.md' }), 'docs/h.md': '# v1' });
  await feed.poll();
  assert.deepEqual(log, [['open', 'h', 'Handoff', '# v1']]);
  await feed.poll();
  assert.equal(log.length, 1, 'same content, no change');
  files['docs/h.md'] = '# v2';
  await feed.poll();
  assert.deepEqual(log.at(-1), ['update', 'h', '# v2']);
});

test('inline markdown works without a file', async () => {
  const { feed, log } = recorder({ 'windows.json': manifest({ id: 'n', markdown: '# note' }) });
  await feed.poll();
  assert.deepEqual(log, [['open', 'n', 'n', '# note']]);
});

test('an id that leaves the manifest closes; a missing manifest closes everything', async () => {
  const { feed, log, files } = recorder({ 'windows.json': manifest({ id: 'a', markdown: 'A' }, { id: 'b', markdown: 'B' }) });
  await feed.poll();
  files['windows.json'] = manifest({ id: 'b', markdown: 'B' });
  await feed.poll();
  assert.deepEqual(log.at(-1), ['close', 'a']);
  delete files['windows.json']; // 404
  await feed.poll();
  assert.deepEqual(log.at(-1), ['close', 'b']);
  await feed.poll();
  assert.equal(log.filter((l) => l[0] === 'close').length, 2, 'closed once each');
});

test('errors leave what is on screen alone', async () => {
  const { feed, log, files } = recorder({ 'windows.json': manifest({ id: 'a', path: 'a.md' }), 'a.md': 'text' });
  await feed.poll();
  files['windows.json'] = new Error('offline'); // network error
  await feed.poll();
  files['windows.json'] = 500; // server error
  await feed.poll();
  files['windows.json'] = '{ half written';
  await feed.poll();
  files['windows.json'] = manifest({ id: 'a', path: 'a.md' });
  files['a.md'] = 500; // file briefly unreadable
  await feed.poll();
  assert.deepEqual(log, [['open', 'a', 'a', 'text']], 'nothing opened twice, nothing closed');
});

test('a file that cannot be read yet is retried on the next poll', async () => {
  const { feed, log, files } = recorder({ 'windows.json': manifest({ id: 'a', path: 'late.md' }) });
  await feed.poll();
  assert.deepEqual(log, []);
  files['late.md'] = 'now here';
  await feed.poll();
  assert.deepEqual(log, [['open', 'a', 'a', 'now here']]);
});

test('start polls at once and on a timer; stop ends it', async () => {
  const { feed, log } = recorder({ 'windows.json': manifest({ id: 'a', markdown: 'x' }) });
  feed.intervalMs = 5;
  feed.start();
  feed.start(); // a second start does not double up
  await new Promise((r) => setTimeout(r, 40));
  feed.stop();
  assert.equal(log.length, 1);
  assert.equal(feed.timer, null);
});

test('WindowManager.remove takes a window out of the scene for good', () => {
  const scene = new THREE.Scene();
  const m = new WindowManager({ scene, store: null });
  const p = new MarkdownPanel({ text: '# x' });
  m.add(p, { id: 'doc-a', title: 'A', placement: { pos: [0, 0, -1] } });
  assert.equal(m.panels.length, 2);
  assert.equal(m.remove('doc-a'), true);
  assert.equal(m.panels.length, 0);
  assert.equal(p.mesh.parent, null);
  assert.equal(m.find('doc-a'), null);
  assert.equal(m.remove('doc-a'), false);
});
