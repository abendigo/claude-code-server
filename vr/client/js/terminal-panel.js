// A terminal floating in space. xterm.js runs headless (parser + screen
// buffer only, no DOM), connected to the gateway's ttyd; this class paints
// the cell grid onto a canvas that is used as a texture. Painting ourselves
// instead of using xterm's renderers keeps us independent of the DOM, which
// doesn't exist inside an immersive session.
import { Terminal } from 'xterm-headless';
import { Panel } from './panel.js';
import { TtydConnection } from './ttyd.js';

const FONT_FAMILY = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
const FONT_PX = 26;
const PAD = 14;
const TITLE_H = 40;
const BG = '#0b0f14';
const FG = '#d8dee9';
const MIN_FRAME_MS = 40;

// xterm's 256-colour palette: 16 ANSI, a 6x6x6 cube, then 24 greys.
const PALETTE = (() => {
  const p = [
    '#1d2127', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
    '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#7ec3ff', '#e08cff', '#73d0dc', '#ffffff',
  ];
  const lvl = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    p.push(`rgb(${lvl[Math.floor(i / 36)]},${lvl[Math.floor(i / 6) % 6]},${lvl[i % 6]})`);
  }
  for (let i = 0; i < 24; i++) { const v = 8 + i * 10; p.push(`rgb(${v},${v},${v})`); }
  return p;
})();

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export class TerminalPanel extends Panel {
  // widthM: physical width in metres. autoSession answers the gateway's
  // "which session?" prompts with "new, default name" so connecting needs no typing.
  constructor({ name, widthM = 1.3, cols = 100, rows = 30, ttydUrl, autoSession = true }) {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${FONT_PX}px ${FONT_FAMILY}`;
    const cw = Math.ceil(probe.measureText('M').width);
    const ch = Math.round(FONT_PX * 1.3);
    const pxW = cols * cw + PAD * 2;
    const pxH = rows * ch + PAD * 2 + TITLE_H;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name });

    this.cols = cols;
    this.rows = rows;
    this.cw = cw;
    this.ch = ch;
    this.status = 'connecting';
    this.cell = null;
    this.lastDraw = 0;
    this.autoSession = autoSession;
    this.onActivate = null;

    this.term = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
    this.term.onData((d) => this.conn.send(d)); // e.g. answers to terminal queries
    this.conn = new TtydConnection(ttydUrl, {
      onOutput: (bytes) => this.term.write(bytes, () => { this.markDirty(); this.autoAnswer(); }),
      onStatus: (s) => { this.status = s; this.markDirty(); },
    });
    this.connect();
  }

  connect() {
    this.autoState = this.autoSession ? 'picker' : 'done';
    this.conn.connect(this.cols, this.rows);
  }

  send(text) { this.conn.send(text); }

  paste(text) {
    this.send(this.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
  }

  onClick() {
    if (this.status === 'disconnected') this.connect();
    this.onActivate?.(this);
  }

  screenText() {
    const buf = this.term.buffer.active;
    let out = '';
    for (let y = 0; y < this.rows; y++) out += (buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '') + '\n';
    return out;
  }

  // The gateway's ttyd-session script asks "Choose [n]:" when sessions exist,
  // then "Name for new session [...]:". Answer both so a fresh panel lands in
  // its own new tmux session without any typing. Each prompt is answered once.
  autoAnswer() {
    if (this.autoState === 'done') return;
    const text = this.screenText();
    if (this.autoState === 'picker' && /Choose \[n\]:\s*$/m.test(text)) {
      this.autoState = 'name';
      this.send('n\r');
    } else if (/Name for new session \[[^\]]*\]:\s*$/m.test(text)) {
      // Reached from either path: no sessions existed (no picker) or we chose 'n'.
      this.autoState = 'done';
      this.send('\r');
    }
  }

  color(isDefault, isRGB, isPalette, value, fallback) {
    if (isDefault) return fallback;
    if (isRGB) return hex(value);
    if (isPalette) return PALETTE[value] ?? fallback;
    return fallback;
  }

  update() {
    if (!this.dirty) return;
    const now = performance.now();
    if (now - this.lastDraw < MIN_FRAME_MS) return;
    this.lastDraw = now;
    super.update();
  }

  draw(ctx, w, h) {
    const { cw, ch } = this;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // Title strip: name and connection state.
    ctx.fillStyle = this.focused ? '#1f3a5f' : '#161c24';
    ctx.fillRect(0, 0, w, TITLE_H);
    ctx.font = `600 22px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#cfd8e3';
    ctx.fillText(`${this.name}`, PAD, TITLE_H / 2 + 1);
    const stateColor = { connected: '#98c379', connecting: '#e5c07b', disconnected: '#e06c75' }[this.status];
    const label = this.status === 'disconnected' ? 'disconnected - point and click to reconnect' : this.status;
    ctx.fillStyle = stateColor;
    ctx.textAlign = 'right';
    ctx.fillText(label, w - PAD, TITLE_H / 2 + 1);
    ctx.textAlign = 'left';

    const top = TITLE_H + PAD;
    const buf = this.term.buffer.active;
    this.cell = this.cell ?? buf.getNullCell();
    const cell = this.cell;
    let curFont = '';

    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      const py = top + y * ch;
      for (let x = 0; x < this.cols; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (width === 0) continue;
        let fg = this.color(cell.isFgDefault(), cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), FG);
        let bg = this.color(cell.isBgDefault(), cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), BG);
        if (cell.isInverse()) [fg, bg] = [bg, fg];
        const px = PAD + x * cw;
        if (bg !== BG) {
          ctx.fillStyle = bg;
          ctx.fillRect(px, py, cw * width, ch);
        }
        const chars = cell.getChars();
        if (!chars || chars === ' ' || cell.isInvisible()) continue;
        const font = `${cell.isItalic() ? 'italic ' : ''}${cell.isBold() ? 'bold ' : ''}${FONT_PX}px ${FONT_FAMILY}`;
        if (font !== curFont) { ctx.font = font; curFont = font; }
        ctx.globalAlpha = cell.isDim() ? 0.6 : 1;
        ctx.fillStyle = fg;
        ctx.fillText(chars, px, py + ch / 2 + 1);
        ctx.globalAlpha = 1;
        if (cell.isUnderline()) ctx.fillRect(px, py + ch - 4, cw * width, 2);
      }
    }

    // Cursor: solid when focused, outline otherwise.
    const cx = PAD + buf.cursorX * cw;
    const cy = top + buf.cursorY * ch;
    if (this.focused) {
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx, cy, cw, ch);
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = '#7a8594';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
    }

    ctx.lineWidth = 6;
    ctx.strokeStyle = this.focused ? '#4da3ff' : '#2a323d';
    ctx.strokeRect(3, 3, w - 6, h - 6);
  }
}
