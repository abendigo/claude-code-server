// On-screen QWERTY for when a terminal needs real typing. Keys go through the
// same keyToSequence() as a physical keyboard, so Ctrl/Alt/Shift behave the
// same. Shift cycles off -> once -> caps lock; Ctrl and Alt are one-shot.
import { Panel, roundRect } from './panel.js';
import { keyToSequence } from './keys.js';

const FONT = 'ui-sans-serif, system-ui, sans-serif';
const ROW_H = 104;
const PAD = 14;

const pair = (a, b) => ({ key: a, shifted: b });
const letters = (s) => [...s].map((c) => ({ key: c, letter: true }));
const named = (label, key, w = 1) => ({ label, key, w });
const mod = (label, m, w) => ({ label, mod: m, w });

const ROWS = [
  [pair('`', '~'), pair('1', '!'), pair('2', '@'), pair('3', '#'), pair('4', '$'), pair('5', '%'), pair('6', '^'),
    pair('7', '&'), pair('8', '*'), pair('9', '('), pair('0', ')'), pair('-', '_'), pair('=', '+'), named('Bksp', 'Backspace', 1.6)],
  [named('Tab', 'Tab', 1.4), ...letters('qwertyuiop'), pair('[', '{'), pair(']', '}'), pair('\\', '|')],
  [mod('Ctrl', 'ctrl', 1.7), ...letters('asdfghjkl'), pair(';', ':'), pair("'", '"'), named('Enter', 'Enter', 1.7)],
  [mod('Shift', 'shift', 2.1), ...letters('zxcvbnm'), pair(',', '<'), pair('.', '>'), pair('/', '?'), mod('Shift', 'shift', 1.5)],
  [named('Esc', 'Escape', 1.4), mod('Alt', 'alt', 1.4), { label: 'space', key: ' ', w: 6 },
    named('←', 'ArrowLeft'), named('↓', 'ArrowDown'), named('↑', 'ArrowUp'), named('→', 'ArrowRight')],
];

export class KeyboardPanel extends Panel {
  constructor({ widthM = 1.3, onSend }) {
    const pxW = 1500;
    const pxH = ROWS.length * ROW_H + PAD * 2;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name: 'keyboard' });
    this.onSend = onSend;
    this.shift = 0; // 0 off, 1 once, 2 caps lock
    this.ctrl = false;
    this.alt = false;
    this.pressed = null;
    this.hoverKey = null;
    this.layout = this.computeLayout();
  }

  // Every row is scaled to span the full width regardless of its key weights.
  computeLayout() {
    const rects = [];
    ROWS.forEach((row, r) => {
      const total = row.reduce((s, k) => s + (k.w ?? 1), 0);
      const unit = (this.pxW - PAD * 2) / total;
      let x = PAD;
      for (const k of row) {
        const w = (k.w ?? 1) * unit;
        rects.push({ k, x: x + 3, y: PAD + r * ROW_H + 3, w: w - 6, h: ROW_H - 6 });
        x += w;
      }
    });
    return rects;
  }

  keyAt(h) {
    if (!h) return null;
    const x = h.u * this.pxW;
    const y = h.v * this.pxH;
    return this.layout.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.k ?? null;
  }

  setHover(uv) {
    super.setHover(uv);
    const k = this.keyAt(this.hover);
    if (k !== this.hoverKey) { this.hoverKey = k; this.markDirty(); }
  }

  shifted() { return this.shift > 0; }

  onClick(h) {
    const k = this.keyAt(h);
    if (!k) return;
    this.pressed = k;
    setTimeout(() => { this.pressed = null; this.markDirty(); }, 130);
    this.markDirty();

    if (k.mod === 'shift') { this.shift = (this.shift + 1) % 3; return; }
    if (k.mod === 'ctrl') { this.ctrl = !this.ctrl; return; }
    if (k.mod === 'alt') { this.alt = !this.alt; return; }

    let key = k.key;
    if (k.letter && this.shifted()) key = key.toUpperCase();
    else if (k.shifted && this.shifted()) key = k.shifted;
    const seq = keyToSequence({
      key, ctrlKey: this.ctrl, altKey: this.alt, shiftKey: this.shifted(), metaKey: false,
    });
    if (seq) this.onSend(seq);
    // Modifiers are one-shot (shift unless locked).
    this.ctrl = false;
    this.alt = false;
    if (this.shift === 1) this.shift = 0;
  }

  label(k) {
    if (k.label) return k.label;
    if (k.letter) return this.shifted() ? k.key.toUpperCase() : k.key;
    return k.shifted && this.shifted() ? k.shifted : k.key;
  }

  isActive(k) {
    return (k.mod === 'shift' && this.shift > 0) || (k.mod === 'ctrl' && this.ctrl) || (k.mod === 'alt' && this.alt);
  }

  draw(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(14,18,24,0.94)';
    roundRect(ctx, 0, 0, w, h, 24);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const { k, x, y, w: kw, h: kh } of this.layout) {
      ctx.fillStyle = k === this.pressed ? '#4da3ff'
        : this.isActive(k) ? (k.mod === 'shift' && this.shift === 2 ? '#8a5cd0' : '#2f6fb5')
          : k === this.hoverKey ? '#2d3f57' : (k.mod || (k.label && !k.letter)) ? '#161f2b' : '#1d2733';
      roundRect(ctx, x, y, kw, kh, 14);
      ctx.fill();
      ctx.fillStyle = '#e6edf5';
      const text = this.label(k);
      ctx.font = `600 ${text.length > 2 ? 32 : 46}px ${FONT}`;
      ctx.fillText(text, x + kw / 2, y + kh / 2 + 2);
    }
    ctx.textAlign = 'left';
  }
}
