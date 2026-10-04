import test from 'node:test';
import assert from 'node:assert/strict';

const storage = {};
globalThis.localStorage = { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };
const { ToolGroup } = await import('../client/js/tools.js');

const fakePanels = (n) => Array.from({ length: n }, () => ({ mesh: { visible: true } }));
const reset = () => { for (const k of Object.keys(storage)) delete storage[k]; };

test('with a conversation the tools start hidden', () => {
  reset();
  const ps = fakePanels(3);
  const g = new ToolGroup(ps, { persist: true });
  assert.equal(g.visible, false);
  assert.ok(ps.every((p) => p.mesh.visible === false));
});

test('toggle shows and hides all of them, and the choice is remembered', () => {
  reset();
  const ps = fakePanels(3);
  const g = new ToolGroup(ps, { persist: true });
  g.toggle();
  assert.ok(ps.every((p) => p.mesh.visible === true));
  assert.equal(storage['vr.tools'], '1');
  const again = new ToolGroup(fakePanels(2), { persist: true }); // a later visit
  assert.equal(again.visible, true);
  g.toggle();
  assert.equal(storage['vr.tools'], '0');
});

test('without a conversation the terminal is all there is, so tools start visible and are not saved', () => {
  reset();
  storage['vr.tools'] = '0'; // a stale choice must not hide the only thing on screen
  const ps = fakePanels(2);
  const g = new ToolGroup(ps, { persist: false });
  assert.equal(g.visible, true);
  assert.ok(ps.every((p) => p.mesh.visible));
  g.toggle();
  assert.equal(storage['vr.tools'], '0'); // untouched
});

test('onChange fires on construction and on every change, with the new state', () => {
  reset();
  const seen = [];
  const g = new ToolGroup(fakePanels(1), { persist: true, onChange: (v) => seen.push(v) });
  g.toggle();
  g.toggle();
  assert.deepEqual(seen, [false, true, false]);
});
