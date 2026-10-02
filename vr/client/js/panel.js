// A Panel is a rectangle floating in the scene whose face is a 2D canvas.
// Everything visible in VR (terminals, buttons, dashboards later) is a Panel
// subclass: implement draw(ctx, w, h), and optionally hit()/onClick().
// Panels know nothing about controllers; main.js does raycasting and calls
// setHover(uv) / click(uv) on whichever panel is pointed at.
import * as THREE from 'three';

export class Panel {
  // widthM/heightM: size in metres; pxW/pxH: canvas resolution.
  constructor({ widthM, heightM, pxW, pxH, name = 'panel' }) {
    this.name = name;
    this.pxW = pxW;
    this.pxH = pxH;
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.DoubleSide, transparent: true }),
    );
    this.mesh.userData.panel = this;
    this.focused = false;
    this.hover = null; // {u, v} in 0..1 canvas space (v down), or null
    this.dirty = true;
  }

  markDirty() { this.dirty = true; }

  setFocused(f) {
    if (this.focused === f) return;
    this.focused = f;
    this.markDirty();
  }

  // uv is three.js style (origin bottom-left); store top-left canvas space.
  setHover(uv) {
    const h = uv ? { u: uv.x, v: 1 - uv.y } : null;
    const changed = (h === null) !== (this.hover === null) || (h && this.hoverChanged(h));
    this.hover = h;
    if (changed) this.markDirty();
  }
  hoverChanged() { return false; } // subclasses with hover visuals override

  click(uv) { this.onClick({ u: uv.x, v: 1 - uv.y }); }
  onClick() {}
  onScroll() {}

  draw() {} // subclasses

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw(this.ctx, this.pxW, this.pxH);
    this.texture.needsUpdate = true;
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Greedy word wrap into lines no wider than maxW.
export function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line && ctx.measureText(line + word).width > maxW) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
