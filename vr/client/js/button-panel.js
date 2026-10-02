// A grid of big, laser-friendly buttons. Each button either sends bytes to the
// focused terminal (`send`) or runs a callback (`run`).
import { Panel, roundRect } from './panel.js';

export class ButtonPanel extends Panel {
  // buttons: [{label, sub?, send?, run?}] laid out row-major in `cols` columns.
  constructor({ name, widthM, cols, buttons, rowPx = 110, colPx = 170, onSend }) {
    const rows = Math.ceil(buttons.length / cols);
    const pxW = cols * colPx + 20;
    const pxH = rows * rowPx + 20;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name });
    this.buttons = buttons;
    this.cols = cols;
    this.rowPx = rowPx;
    this.colPx = colPx;
    this.onSend = onSend;
    this.hoverIdx = -1;
    this.pressedIdx = -1;
  }

  indexAt(h) {
    if (!h) return -1;
    const x = h.u * this.pxW - 10;
    const y = h.v * this.pxH - 10;
    const c = Math.floor(x / this.colPx);
    const r = Math.floor(y / this.rowPx);
    if (x < 0 || y < 0 || c < 0 || c >= this.cols || r < 0) return -1;
    const i = r * this.cols + c;
    return i < this.buttons.length ? i : -1;
  }

  setHover(uv) {
    super.setHover(uv);
    const idx = this.indexAt(this.hover);
    if (idx !== this.hoverIdx) { this.hoverIdx = idx; this.markDirty(); }
  }

  onClick(h) {
    const idx = this.indexAt(h);
    if (idx < 0) return;
    const b = this.buttons[idx];
    this.pressedIdx = idx;
    this.markDirty();
    setTimeout(() => { this.pressedIdx = -1; this.markDirty(); }, 140);
    if (b.send !== undefined) this.onSend?.(b.send);
    b.run?.();
  }

  draw(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(14,18,24,0.92)';
    roundRect(ctx, 0, 0, w, h, 24);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.buttons.forEach((b, i) => {
      const x = 10 + (i % this.cols) * this.colPx + 6;
      const y = 10 + Math.floor(i / this.cols) * this.rowPx + 6;
      const bw = this.colPx - 12;
      const bh = this.rowPx - 12;
      ctx.fillStyle = i === this.pressedIdx ? '#4da3ff' : i === this.hoverIdx ? '#2d3f57' : '#1d2733';
      roundRect(ctx, x, y, bw, bh, 16);
      ctx.fill();
      ctx.fillStyle = '#e6edf5';
      ctx.font = `600 ${b.sub ? 40 : 46}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(b.label, x + bw / 2, y + bh / 2 - (b.sub ? 10 : 0));
      if (b.sub) {
        ctx.fillStyle = '#8b9bb0';
        ctx.font = '24px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(b.sub, x + bw / 2, y + bh / 2 + 28);
      }
    });
    ctx.textAlign = 'left';
  }
}

// The keys you actually need when you can't type: answer prompts, move around,
// and drive tmux copy-mode (the only way to scroll back inside tmux).
export function quickKeys(onSend) {
  return new ButtonPanel({
    name: 'keys',
    widthM: 1.1,
    cols: 6,
    onSend,
    buttons: [
      { label: 'Enter', send: '\r' },
      { label: 'Esc', send: '\x1b' },
      { label: '^C', send: '\x03' },
      { label: 'Tab', send: '\t' },
      { label: '⇧Tab', sub: 'mode', send: '\x1b[Z' },
      { label: '/', send: '/' },
      { label: '1', send: '1' },
      { label: '2', send: '2' },
      { label: '3', send: '3' },
      { label: 'y', send: 'y' },
      { label: 'n', send: 'n' },
      { label: '⌫', send: '\x7f' },
      { label: '←', send: '\x1b[D' },
      { label: '↑', send: '\x1b[A' },
      { label: '↓', send: '\x1b[B' },
      { label: '→', send: '\x1b[C' },
      { label: 'Scroll', sub: 'tmux', send: '\x02[' },
      { label: 'q', sub: 'leave', send: 'q' },
      { label: 'PgUp', send: '\x1b[5~' },
      { label: 'PgDn', send: '\x1b[6~' },
      { label: '^D', send: '\x04' },
      { label: '^L', sub: 'clear', send: '\x0c' },
      { label: '^R', send: '\x12' },
      { label: 'Esc Esc', sub: 'rewind', send: '\x1b\x1b' },
    ],
  });
}
