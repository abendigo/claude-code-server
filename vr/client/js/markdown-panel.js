// A read-only window that shows a markdown document: headings, paragraphs,
// lists, code, quotes, rules and tables, scrolled with the thumbstick or wheel
// (the same onScroll(amount) the conversation uses). Text only, with vector
// bullets, so it never depends on glyphs the headset's fonts may lack.
import { Panel, roundRect, wrapText } from './panel.js';
import { parseMarkdown } from './markdown.js';

const PX_PER_M = 1200;
const PAD = 40;
const BODY = 28;
const MONO = '"DejaVu Sans Mono", Consolas, monospace';
const COLORS = { bg: '#0d1117', text: '#d7e0ea', dim: '#8b98a8', head: '#ffffff', rule: '#2a3441', codeBg: '#161d27', quote: '#4da3ff', bar: '#2a3441', thumb: '#4a5a70' };

const HEADING = { 1: [46, 18], 2: [38, 14], 3: [32, 10], 4: [30, 8], 5: [28, 6], 6: [28, 6] }; // [font px, space above]

export class MarkdownPanel extends Panel {
  constructor({ text = '', widthM = 0.95, heightM = 1.2, name = 'markdown' } = {}) {
    super({ widthM, heightM, pxW: Math.round(widthM * PX_PER_M), pxH: Math.round(heightM * PX_PER_M), name });
    this.scroll = 0;
    this.set(text);
  }

  set(text) {
    this.blocks = parseMarkdown(text);
    this.laid = null; // laid out at the next draw, when a canvas context is at hand
    this.markDirty();
  }

  onScroll(amount) {
    const max = Math.max(0, (this.laid?.height ?? 0) - this.pxH);
    this.scroll = Math.min(max, Math.max(0, this.scroll + amount * 40));
    this.markDirty();
  }

  // Turn blocks into positioned primitives, once per document and width.
  layout(ctx) {
    const left = PAD;
    const width = this.pxW - PAD * 2 - 16; // room for the scroll bar
    const items = [];
    let y = PAD;

    const text = (str, x, w, size, color, font = 'sans-serif', weight = 400, lh = 1.35) => {
      ctx.font = `${weight} ${size}px ${font}`;
      for (const line of wrapText(ctx, str, w)) {
        items.push({ k: 'text', x, y, text: line, font: ctx.font, color });
        y += Math.round(size * lh);
      }
    };

    for (const b of this.blocks) {
      if (b.t === 'h') {
        const [size, above] = HEADING[b.level];
        y += above;
        text(b.text, left, width, size, COLORS.head, 'sans-serif', 700, 1.25);
        if (b.level <= 2) { items.push({ k: 'rule', x: left, y: y + 2, w: width }); y += 10; }
        y += 8;
      } else if (b.t === 'p') {
        text(b.text, left, width, BODY, COLORS.text);
        y += 14;
      } else if (b.t === 'li') {
        const indent = b.depth * 36;
        const x = left + indent + 40;
        if (b.marker === '-') items.push({ k: 'dot', x: left + indent + 16, y: y + BODY * 0.55 });
        else items.push({ k: 'text', x: left + indent, y, text: b.marker, font: `400 ${BODY}px sans-serif`, color: COLORS.dim });
        text(b.text, x, width - indent - 40, BODY, COLORS.text);
        y += 6;
      } else if (b.t === 'quote') {
        const top = y;
        text(b.text, left + 28, width - 28, BODY, COLORS.dim);
        items.unshift({ k: 'bar', x: left + 6, y: top, h: y - top, color: COLORS.quote });
        y += 14;
      } else if (b.t === 'code') {
        const size = 24;
        const lh = Math.round(size * 1.35);
        const wrapped = [];
        ctx.font = `400 ${size}px ${MONO}`;
        for (const l of b.lines.length ? b.lines : ['']) wrapped.push(...wrapText(ctx, l.replace(/\t/g, '  '), width - 32));
        const h = wrapped.length * lh + 24;
        items.push({ k: 'box', x: left, y, w: width, h });
        wrapped.forEach((l, i) => items.push({ k: 'text', x: left + 16, y: y + 12 + i * lh, text: l, font: ctx.font, color: COLORS.text }));
        y += h + 14;
      } else if (b.t === 'hr') {
        items.push({ k: 'rule', x: left, y: y + 8, w: width });
        y += 24;
      } else if (b.t === 'table') {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const cw = width / cols;
        b.rows.forEach((row, ri) => {
          const rowTop = y;
          let rowBottom = y;
          row.forEach((cell, ci) => {
            y = rowTop;
            text(cell, left + ci * cw + 8, cw - 16, 24, ri === 0 ? COLORS.head : COLORS.text, 'sans-serif', ri === 0 ? 700 : 400);
            rowBottom = Math.max(rowBottom, y);
          });
          y = rowBottom + 6;
          items.push({ k: 'rule', x: left, y: y - 3, w: width });
        });
        y += 12;
      }
    }
    return { items, height: y + PAD, width: this.pxW };
  }

  draw(ctx, w, h) {
    if (!this.laid || this.laid.width !== w) this.laid = this.layout(ctx);
    const max = Math.max(0, this.laid.height - h);
    this.scroll = Math.min(this.scroll, max);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.bg;
    roundRect(ctx, 0, 0, w, h, 18);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const it of this.laid.items) {
      const y = it.y - this.scroll;
      const bottom = y + (it.h ?? 60);
      if (bottom < 0 || y > h) continue; // off screen
      if (it.k === 'text') { ctx.font = it.font; ctx.fillStyle = it.color; ctx.fillText(it.text, it.x, y); }
      else if (it.k === 'rule') { ctx.fillStyle = COLORS.rule; ctx.fillRect(it.x, y, it.w, 2); }
      else if (it.k === 'box') { ctx.fillStyle = COLORS.codeBg; roundRect(ctx, it.x, y, it.w, it.h, 10); ctx.fill(); }
      else if (it.k === 'bar') { ctx.fillStyle = it.color; ctx.fillRect(it.x, y, 5, it.h); }
      else if (it.k === 'dot') { ctx.fillStyle = COLORS.dim; ctx.beginPath(); ctx.arc(it.x, y, 5, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();

    if (max > 0) { // scroll bar
      const track = h - 24;
      const thumb = Math.max(40, track * (h / this.laid.height));
      ctx.fillStyle = COLORS.bar;
      roundRect(ctx, w - 18, 12, 8, track, 4);
      ctx.fill();
      ctx.fillStyle = COLORS.thumb;
      roundRect(ctx, w - 18, 12 + (track - thumb) * (this.scroll / max), 8, thumb, 4);
      ctx.fill();
    }
  }
}
