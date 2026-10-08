// The windowing layer: title bars, drag, home/close, remembered places, and that
// a bar belongs to (and moves, hides and grabs with) its window.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { Panel } = await import('../client/js/panel.js');
const { WindowManager, TitleBar, Drag, faceYaw, BAR_M } = await import('../client/js/windows.js');

const memory = () => {
  const s = {};
  return { s, getItem: (k) => s[k] ?? null, setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } };
};
const setup = (store = memory()) => {
  const scene = new THREE.Scene();
  const closed = [];
  const m = new WindowManager({ scene, store, onClose: (w) => closed.push(w.id) });
  const panel = new Panel({ widthM: 1, heightM: 0.5, pxW: 100, pxH: 50, name: 'p' });
  const win = m.add(panel, { id: 'a', title: 'Alpha', placement: { pos: [0, 1.5, -1], rotX: 0, rotY: 0 } });
  scene.updateMatrixWorld(true);
  return { scene, m, panel, win, store, closed };
};

test('adding a window puts it in the scene at its placement, with a title bar above it', () => {
  const { scene, panel, win, m } = setup();
  assert.equal(panel.mesh.parent, scene);
  assert.deepEqual(panel.mesh.position.toArray(), [0, 1.5, -1]);
  assert.ok(win.bar instanceof TitleBar);
  assert.equal(win.bar.mesh.parent, panel.mesh);
  assert.ok(win.bar.mesh.position.y > 0.25, 'the bar sits above the top edge');
  assert.deepEqual(m.panels, [panel, win.bar]);
});

test('a title bar is as wide as its window and knows its owner', () => {
  const { panel, win } = setup();
  assert.equal(win.bar.mesh.geometry.parameters.width, 1);
  assert.equal(win.bar.mesh.geometry.parameters.height, BAR_M);
  assert.equal(win.bar.owner, panel);
});

test('byPanel finds the window from its panel or its bar', () => {
  const { panel, win, m } = setup();
  assert.equal(m.byPanel(panel), win);
  assert.equal(m.byPanel(win.bar), win);
  assert.equal(m.byPanel(new Panel({ widthM: 1, heightM: 1, pxW: 4, pxH: 4 })), null);
});

test('the bar redraws when its window gains or loses focus', () => {
  const { panel, win } = setup();
  win.bar.update(); // first draw
  assert.equal(win.bar.dirty, false);
  panel.setFocused(true);
  win.bar.update();
  assert.equal(win.bar.drawnFocus, true);
  panel.setFocused(false);
  win.bar.update();
  assert.equal(win.bar.drawnFocus, false);
});

test('a bar moves, resizes and hides with its window', () => {
  const { scene, panel, win } = setup();
  panel.mesh.position.set(2, 1, -3);
  panel.mesh.scale.setScalar(2);
  scene.updateMatrixWorld(true);
  const world = win.bar.mesh.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(world.x - 2) < 1e-9);
  assert.ok(world.y > 1 + 0.25 * 2, 'scaled with the window');
  assert.equal(win.bar.shown, true);
  panel.mesh.visible = false;
  assert.equal(win.bar.shown, false, 'hidden window, hidden bar, so it cannot be pointed at');
  assert.equal(panel.shown, false);
});

test('button zones: home and close, or just home when closing is not allowed', () => {
  const { win } = setup();
  assert.deepEqual(win.bar.zones().map((z) => z.id), ['close', 'home']);
  const last = win.bar.zones().at(-1);
  const closeAt = { u: (win.bar.pxW - 2) / win.bar.pxW, v: 0.5 };
  const homeAt = { u: (last.x0 + 2) / win.bar.pxW, v: 0.5 };
  assert.equal(win.bar.zoneAt(closeAt), 'close');
  assert.equal(win.bar.zoneAt(homeAt), 'home');
  assert.equal(win.bar.zoneAt({ u: 0.1, v: 0.5 }), null);
  assert.equal(win.bar.isDragPoint({ x: 0.1, y: 0.5 }), true);
  assert.equal(win.bar.isDragPoint({ x: closeAt.u, y: 0.5 }), false);

  const s = new THREE.Scene();
  const fixed = new WindowManager({ scene: s, store: null }).add(new Panel({ widthM: 1, heightM: 1, pxW: 4, pxH: 4 }), { id: 'x', title: 'X', placement: { pos: [0, 0, 0] }, closable: false });
  assert.deepEqual(fixed.bar.zones().map((z) => z.id), ['home']);
});

test('close hides the window and tells the manager; an unclosable window ignores close', () => {
  const { win, panel, closed } = setup();
  win.bar.onClick({ u: 0.999, v: 0.5 });
  assert.equal(panel.mesh.visible, false);
  assert.deepEqual(closed, ['a']);

  const s = new THREE.Scene();
  const p = new Panel({ widthM: 1, heightM: 1, pxW: 4, pxH: 4 });
  const w = new WindowManager({ scene: s, store: null }).add(p, { id: 'y', title: 'Y', placement: { pos: [0, 0, 0] }, closable: false });
  w.close();
  assert.equal(p.mesh.visible, true);
});

test('dragging keeps the grabbed spot under the ray and turns the window toward you', () => {
  const { panel, win, m } = setup();
  const origin = new THREE.Vector3(0, 1.4, 0);
  const grabPoint = new THREE.Vector3(0.2, 1.8, -1); // on the bar
  const ray = new THREE.Ray(origin, grabPoint.clone().sub(origin).normalize());
  const drag = m.beginDrag(win.bar, ray, grabPoint);
  assert.ok(drag instanceof Drag);

  // Aim the ray somewhere else: the window follows, offset preserved.
  const newDir = new THREE.Vector3(-1, 0, -1).normalize();
  drag.update(new THREE.Ray(origin, newDir), origin);
  const spot = origin.clone().addScaledVector(newDir, grabPoint.distanceTo(origin));
  const expected = spot.add(new THREE.Vector3(-0.2, -0.3, 0));
  assert.ok(panel.mesh.position.distanceTo(expected) < 1e-9, `${panel.mesh.position.toArray()} vs ${expected.toArray()}`);
  assert.ok(Math.abs(panel.mesh.rotation.y - faceYaw(panel.mesh.position, origin)) < 1e-9);
  assert.equal(panel.mesh.rotation.x, 0, 'tilt is kept');
});

test('faceYaw points the panel front (+z) at the eye', () => {
  assert.equal(faceYaw({ x: 0, z: -1 }, { x: 0, z: 0 }), 0);
  assert.ok(faceYaw({ x: -1, z: -1 }, { x: 0, z: 0 }) > 0, 'a window on the left turns right');
  assert.ok(faceYaw({ x: 1, z: -1 }, { x: 0, z: 0 }) < 0, 'a window on the right turns left');
  // After turning, the front faces the eye.
  const pos = { x: -1.5, z: -1 };
  const y = faceYaw(pos, { x: 0, z: 0 });
  const front = new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
  const toEye = new THREE.Vector3(-pos.x, 0, -pos.z).normalize();
  assert.ok(front.distanceTo(toEye) < 1e-9);
});

test('a moved window is remembered, and found there next time', () => {
  const store = memory();
  const a = setup(store);
  a.panel.mesh.position.set(1, 2, -3);
  a.panel.mesh.rotation.set(0.2, 0.7, 0, 'YXZ');
  a.panel.mesh.scale.setScalar(1.5);
  a.m.save(a.win);

  const b = setup(store); // a later visit, same storage
  assert.deepEqual(b.panel.mesh.position.toArray(), [1, 2, -3]);
  assert.ok(Math.abs(b.panel.mesh.rotation.y - 0.7) < 1e-9);
  assert.ok(Math.abs(b.panel.mesh.rotation.x - 0.2) < 1e-9);
  assert.equal(b.panel.mesh.scale.x, 1.5);
});

test('home puts a window back and forgets the saved place; resetAll does it for every window', () => {
  const store = memory();
  const { panel, win, m } = setup(store);
  panel.mesh.position.set(9, 9, 9);
  m.save(win);
  assert.ok(store.s['vr.win.a']);
  win.bar.onClick({ u: (win.bar.zones().at(-1).x0 + 2) / win.bar.pxW, v: 0.5 });
  assert.deepEqual(panel.mesh.position.toArray(), [0, 1.5, -1]);
  assert.equal(store.s['vr.win.a'], undefined);

  const other = m.add(new Panel({ widthM: 1, heightM: 1, pxW: 4, pxH: 4 }), { id: 'b', title: 'B', placement: { pos: [1, 1, 1] } });
  panel.mesh.position.set(5, 5, 5);
  other.panel.mesh.position.set(6, 6, 6);
  other.panel.mesh.visible = false;
  m.resetAll();
  assert.deepEqual(panel.mesh.position.toArray(), [0, 1.5, -1]);
  assert.deepEqual(other.panel.mesh.position.toArray(), [1, 1, 1]);
  assert.equal(other.panel.mesh.visible, false, 'reset moves windows, it does not reopen closed ones');
});

test('garbage in storage is ignored', () => {
  const store = memory();
  for (const bad of ['not json', '{"pos":[1,2]}', '{"pos":[1,2,"x"],"rotX":0,"rotY":0,"scale":1}', 'null']) {
    store.s['vr.win.a'] = bad;
    const { panel } = setup(store);
    assert.deepEqual(panel.mesh.position.toArray(), [0, 1.5, -1], bad);
  }
});

test('a storage that throws never breaks moving windows', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const { win, m, panel } = setup(throwing);
  assert.doesNotThrow(() => { m.save(win); m.forget(win); win.home(); });
  assert.deepEqual(panel.mesh.position.toArray(), [0, 1.5, -1]);
});
