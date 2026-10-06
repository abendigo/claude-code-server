// The windowing layer. Every Panel in the scene (the conversation, the voice
// bar, the keyboard, terminals, and anything Claude opens later) is a window
// managed here: it gets a title bar above it that you drag with the trigger
// (or the mouse) to move it, a home button that puts it back where it started,
// and a close button where closing is safe. Positions are remembered per window
// id in localStorage. Grip-grab still works too (main.js); it reports back here
// so the new place is saved.
import { Panel, roundRect } from './panel.js';

export const BAR_M = 0.07; // title bar height, metres
const GAP_M = 0.01; // between the bar and its window
const PX_PER_M = 800; // bar resolution, so text is the same physical size on every window
const KEY = 'vr.win.';

// Yaw that turns a panel at `pos` to face `eye` (panels face +z at rest).
export function faceYaw(pos, eye) {
  return Math.atan2(eye.x - pos.x, eye.z - pos.z);
}

export class TitleBar extends Panel {
  constructor(win) {
    const { width, height } = win.panel.mesh.geometry.parameters;
    super({
      widthM: width,
      heightM: BAR_M,
      pxW: Math.max(2, Math.round(width * PX_PER_M)),
      pxH: Math.round(BAR_M * PX_PER_M),
      name: `${win.title} bar`,
    });
    this.win = win;
    this.owner = win.panel; // grabbing the bar grabs the window
    // A child of the window's mesh, so it follows every move, resize and hide.
    this.mesh.position.set(0, height / 2 + GAP_M + BAR_M / 2, 0.002);
    win.panel.mesh.add(this.mesh);
  }

  // Button hit zones in canvas pixels, right to left: close, then home.
  zones() {
    const w = this.pxW;
    const b = this.pxH;
    const zones = [];
    let x = w;
    if (this.win.closable) { x -= b; zones.push({ id: 'close', x0: x, x1: x + b }); }
    x -= b;
    zones.push({ id: 'home', x0: x, x1: x + b });
    return zones;
  }

  zoneAt(pt) {
    if (!pt) return null;
    const x = pt.u * this.pxW;
    return this.zones().find((z) => x >= z.x0 && x < z.x1)?.id ?? null;
  }

  // Pressing anywhere except a button starts a drag (see WindowManager.beginDrag).
  isDragPoint(uv) { return this.zoneAt({ u: uv.x, v: 1 - uv.y }) === null; }

  onClick(pt) {
    const zone = this.zoneAt(pt);
    if (zone === 'close') this.win.close();
    else if (zone === 'home') this.win.home();
  }

  hoverChanged(h) { return this.zoneAt(h) !== this.zoneAt(this.hover); }

  // The bar is lit while its window has focus (the window is told, not the bar).
  update() {
    if (this.win.panel.focused !== this.drawnFocus) this.markDirty();
    super.update();
  }

  draw(ctx, w, h) {
    this.drawnFocus = this.win.panel.focused;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.drawnFocus ? '#1d3a5c' : '#17202b';
    roundRect(ctx, 0, 0, w, h, h * 0.3);
    ctx.fill();

    ctx.fillStyle = '#d7e3f2';
    ctx.font = `600 ${Math.round(h * 0.5)}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(this.win.title, h * 0.4, h / 2, Math.max(10, this.zones().at(-1).x0 - h * 0.6));

    const hovered = this.zoneAt(this.hover);
    for (const z of this.zones()) {
      if (hovered === z.id) {
        ctx.fillStyle = z.id === 'close' ? '#8a2f2f' : '#2f5a8a';
        roundRect(ctx, z.x0 + 4, 4, z.x1 - z.x0 - 8, h - 8, h * 0.25);
        ctx.fill();
      }
      ctx.strokeStyle = '#d7e3f2';
      ctx.lineWidth = Math.max(3, h * 0.07);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const cx = (z.x0 + z.x1) / 2;
      const cy = h / 2;
      const r = h * 0.18;
      ctx.beginPath();
      if (z.id === 'close') {
        ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
        ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
      } else { // home: a little house
        ctx.moveTo(cx - r * 1.1, cy); ctx.lineTo(cx, cy - r * 1.1); ctx.lineTo(cx + r * 1.1, cy);
        ctx.moveTo(cx - r * 0.7, cy - r * 0.2); ctx.lineTo(cx - r * 0.7, cy + r); ctx.lineTo(cx + r * 0.7, cy + r); ctx.lineTo(cx + r * 0.7, cy - r * 0.2);
      }
      ctx.stroke();
    }
  }
}

export class Win {
  constructor(manager, { panel, id, title, placement, closable }) {
    this.manager = manager;
    this.panel = panel;
    this.id = id;
    this.title = title;
    this.placement = placement;
    this.closable = closable;
    this.bar = new TitleBar(this);
  }

  // Where this window starts: its layout slot, or the saved place if it was moved.
  applyPlacement(saved) {
    const m = this.panel.mesh;
    if (saved) {
      m.position.set(...saved.pos);
      m.rotation.set(saved.rotX, saved.rotY, 0, 'YXZ');
      m.scale.setScalar(saved.scale);
    } else {
      const { pos, rotX = 0, rotY = 0 } = this.placement;
      m.position.set(...pos);
      m.rotation.set(rotX, rotY, 0, 'YXZ');
      m.scale.setScalar(1);
    }
  }

  home() {
    this.applyPlacement(null);
    this.manager.forget(this);
  }

  close() {
    if (!this.closable) return;
    this.panel.mesh.visible = false;
    this.manager.onClose?.(this);
  }

  open() { this.panel.mesh.visible = true; }
}

// One drag: keeps the spot you grabbed under your pointer at the same distance,
// and turns the window to face you as it moves.
export class Drag {
  constructor(win, ray, point) {
    this.win = win;
    this.distance = point.distanceTo(ray.origin);
    this.offset = win.panel.mesh.position.clone().sub(point);
  }

  update(ray, eye) {
    const m = this.win.panel.mesh;
    m.position.copy(ray.origin).addScaledVector(ray.direction, this.distance).add(this.offset);
    if (eye) m.rotation.set(m.rotation.x, faceYaw(m.position, eye), 0, 'YXZ');
  }
}

export class WindowManager {
  constructor({ scene, store = globalThis.localStorage, onClose } = {}) {
    this.scene = scene;
    this.store = store;
    this.onClose = onClose;
    this.windows = [];
  }

  // Everything pointable: each window's panel and its title bar.
  get panels() { return this.windows.flatMap((w) => [w.panel, w.bar]); }

  add(panel, { id, title, placement, closable = true }) {
    const win = new Win(this, { panel, id, title, placement, closable });
    win.applyPlacement(this.load(id));
    this.scene.add(panel.mesh);
    this.windows.push(win);
    return win;
  }

  find(id) { return this.windows.find((w) => w.id === id) ?? null; }

  // Take a window out of the scene for good (a closed one is only hidden).
  remove(id) {
    const win = this.find(id);
    if (!win) return false;
    for (const p of [win.bar, win.panel]) {
      p.mesh.parent?.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      p.texture.dispose();
    }
    this.windows.splice(this.windows.indexOf(win), 1);
    return true;
  }

  byPanel(panel) {
    const target = panel.owner ?? panel;
    return this.windows.find((w) => w.panel === target) ?? null;
  }

  beginDrag(bar, ray, point) { return new Drag(bar.win, ray, point); }

  load(id) {
    try {
      const v = JSON.parse(this.store?.getItem(KEY + id) ?? 'null');
      return v && Array.isArray(v.pos) && v.pos.length === 3 && [...v.pos, v.rotX, v.rotY, v.scale].every(Number.isFinite) ? v : null;
    } catch { return null; }
  }

  // Remember where this window is now.
  save(win) {
    const m = win.panel.mesh;
    const v = { pos: m.position.toArray(), rotX: m.rotation.x, rotY: m.rotation.y, scale: m.scale.x };
    try { this.store?.setItem(KEY + win.id, JSON.stringify(v)); } catch { /* optional */ }
  }

  forget(win) {
    try { this.store?.removeItem(KEY + win.id); } catch { /* optional */ }
  }

  // Every window back to its starting place. Closed ones stay closed; the Tools toggle brings those back.
  resetAll() {
    for (const w of this.windows) w.home();
  }
}
