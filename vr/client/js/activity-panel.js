// The Activity window: a glanceable view of what Claude is doing, to the side of
// the conversation. A status line that visibly moves while Claude works (spinner
// and a running timer), then one short row per tool call, newest at the bottom.
// No output and no file contents: if you want those, ask. Scrolls like the
// conversation (onScroll(amount); 0 follows new rows).
import { Panel, roundRect } from './panel.js';
import { activityRows, headerStatus, fmtDuration } from './activity.js';

const SANS = 'ui-sans-serif, system-ui, sans-serif';
const MONO = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
const PAD = 28;
const HEAD_H = 150;
const ROW_H = 46;
const TURN_H = 62;
const TONE = { working: '#7fb6ff', waiting: '#ffcc66', idle: '#98c379', connecting: '#e5c07b', offline: '#ff8a8a' };
const MARK = { running: '#e5c07b', ok: '#98c379', error: '#ff8a8a' };
const REDRAW_MS = 200; // while Claude is working, the timer and spinner move this often

export class ActivityPanel extends Panel {
  // getConversation: () => the Conversation model (or null before it exists).
  constructor({ getConversation, widthM = 0.8, clock = Date.now }) {
    const pxW = 960;
    const pxH = 1100;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name: 'activity' });
    this.getConversation = getConversation;
    this.clock = clock;
    this.scroll = 0; // pixels scrolled up from the bottom; 0 follows new rows
    this.lastDraw = 0;
  }

  onScroll(amount) {
    this.scroll = Math.max(0, this.scroll + amount * 40);
    this.markDirty();
  }

  // Keep the spinner and timer moving while there is something to watch.
  update() {
    const c = this.getConversation();
    if (c && (c.state === 'working' || c.state === 'waiting') && this.clock() - this.lastDraw >= REDRAW_MS) this.markDirty();
    super.update();
  }

  // Vector marks: a headset's fonts can't be trusted to have tick or cross glyphs.
  mark(ctx, status, x, cy, now) {
    ctx.save();
    ctx.strokeStyle = MARK[status] ?? MARK.running;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (status === 'ok') { ctx.moveTo(x, cy); ctx.lineTo(x + 8, cy + 9); ctx.lineTo(x + 24, cy - 10); ctx.stroke(); }
    else if (status === 'error') { ctx.moveTo(x + 2, cy - 10); ctx.lineTo(x + 22, cy + 10); ctx.moveTo(x + 22, cy - 10); ctx.lineTo(x + 2, cy + 10); ctx.stroke(); }
    else this.spinner(ctx, x + 12, cy, 11, now, 4);
    ctx.restore();
  }

  spinner(ctx, cx, cy, r, now, width) {
    const a = (now / 700) * Math.PI * 2;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a, a + Math.PI * 1.4);
    ctx.stroke();
  }

  draw(ctx, w, h) {
    const c = this.getConversation();
    const now = this.clock();
    this.lastDraw = now;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f141b';
    roundRect(ctx, 0, 0, w, h, 28);
    ctx.fill();
    if (!c) return;

    // ---- status line --------------------------------------------------------------
    const st = headerStatus(c, now);
    ctx.fillStyle = '#151c26';
    roundRect(ctx, 0, 0, w, HEAD_H, 28);
    ctx.fill();
    const color = TONE[st.tone];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    if (st.tone === 'working') this.spinner(ctx, PAD + 22, 52, 20, now, 6);
    else if (st.tone === 'waiting') { ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(PAD + 22, 52, 14 + 6 * Math.abs(Math.sin(now / 400)), 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(PAD + 22, 52, 14, 0, Math.PI * 2); ctx.fill(); }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `600 40px ${SANS}`;
    ctx.fillText(st.label, PAD + 64, 52);
    if (st.time) {
      ctx.font = `600 36px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(st.time, w - PAD, 52);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = '#9fb0c4';
    ctx.font = `28px ${MONO}`;
    ctx.fillText(this.fit(ctx, st.detail, w - PAD * 2), PAD, 114);

    // ---- rows, newest at the bottom -------------------------------------------------
    const rows = activityRows(c, now);
    const top = HEAD_H + 10;
    const bottom = h - 16;
    const heights = rows.map((r) => (r.kind === 'turn' ? TURN_H : ROW_H));
    const total = heights.reduce((a, b) => a + b, 0);
    const max = Math.max(0, total - (bottom - top));
    this.scroll = Math.min(this.scroll, max);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, w, bottom - top);
    ctx.clip();
    let y = bottom + this.scroll - total;
    rows.forEach((r, i) => {
      const rh = heights[i];
      if (y + rh >= top && y <= bottom) this.row(ctx, r, y, rh, w, now);
      y += rh;
    });
    ctx.restore();

    if (!rows.length) {
      ctx.fillStyle = '#6f8095';
      ctx.font = `28px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText('Nothing yet. What Claude is doing will show here.', w / 2, h / 2);
      ctx.textAlign = 'left';
    }
    if (max > 0) { // scroll bar: the thumb sits at the bottom when following
      const track = bottom - top;
      const thumb = Math.max(40, track * ((bottom - top) / total));
      ctx.fillStyle = '#243040';
      roundRect(ctx, w - 18, top, 8, track, 4);
      ctx.fill();
      ctx.fillStyle = '#4a5a70';
      roundRect(ctx, w - 18, top + (track - thumb) * (1 - this.scroll / max), 8, thumb, 4);
      ctx.fill();
    }
  }

  fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  row(ctx, r, y, rh, w, now) {
    const cy = y + rh / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (r.kind === 'turn') {
      ctx.fillStyle = '#16314d';
      roundRect(ctx, PAD - 10, y + 8, w - PAD * 2 + 20, rh - 14, 12);
      ctx.fill();
      ctx.fillStyle = '#9ec9ff';
      ctx.font = `600 26px ${SANS}`;
      ctx.fillText(this.fit(ctx, r.text, w - PAD * 2 - 20), PAD, cy + 1);
    } else if (r.kind === 'tool') {
      this.mark(ctx, r.status, PAD, cy, now);
      const time = r.ms === null ? '' : fmtDuration(r.ms);
      ctx.font = `600 24px ${MONO}`;
      const tw = time ? ctx.measureText(time).width : 0;
      ctx.font = `26px ${MONO}`;
      ctx.fillStyle = r.status === 'error' ? '#ff9c9c' : r.status === 'running' ? '#f0e0b0' : '#c5d2e0';
      ctx.fillText(this.fit(ctx, r.text, w - PAD * 2 - 52 - tw - 16), PAD + 50, cy + 1);
      if (time) {
        ctx.font = `24px ${MONO}`;
        ctx.fillStyle = '#7d8da2';
        ctx.textAlign = 'right';
        ctx.fillText(time, w - PAD - 8, cy + 1);
        ctx.textAlign = 'left';
      }
    } else {
      const color = r.kind === 'wait' ? '#ffcc66' : '#ff8a8a';
      ctx.fillStyle = color;
      ctx.font = `600 26px ${SANS}`;
      ctx.fillText(this.fit(ctx, `${r.kind === 'wait' ? 'Waiting for you: ' : ''}${r.text}`, w - PAD * 2), PAD, cy + 1);
    }
  }
}
