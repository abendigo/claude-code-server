// The Activity window: a glanceable view of what Claude is doing, to the side of
// the conversation. A status line that visibly moves while Claude works (spinner
// and a running timer), then one short row per tool call, newest at the bottom.
// No output and no file contents: if you want those, ask. Scrolls like the
// conversation (onScroll(amount); 0 follows new rows).
import { Panel, roundRect } from './panel.js';
import { activityRows, backgroundRows, headerStatus, fmtDuration } from './activity.js';

const SANS = 'ui-sans-serif, system-ui, sans-serif';
const MONO = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
const PAD = 28;
const HEAD_H = 150;
const ROW_H = 46;
const TURN_H = 62;
const TONE = { working: '#7fb6ff', waiting: '#ffcc66', idle: '#98c379', connecting: '#e5c07b', offline: '#ff8a8a' };
const MARK = { running: '#e5c07b', ok: '#98c379', error: '#ff8a8a' };
const REDRAW_MS = 200; // while Claude is working, the timer and spinner move this often
const WORKER_H = 76; // one background worker
const WORKERS_TITLE_H = 46;
const MAX_WORKERS_SHOWN = 6;
const CONFIRM_MS = 3000; // a second tap on Stop within this long stops the worker

export class ActivityPanel extends Panel {
  // getConversation: () => the Conversation model (or null before it exists).
  // client (optional): {stopTask(id)}, for the Stop button on a running worker.
  constructor({ getConversation, widthM = 0.8, clock = Date.now, client = null }) {
    const pxW = 960;
    const pxH = 1100;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name: 'activity' });
    this.getConversation = getConversation;
    this.clock = clock;
    this.client = client;
    this.spots = [];
    this.hoverSpot = null;
    this.armed = null; // {id, until}: a worker whose Stop was tapped once
    this.scroll = 0; // pixels scrolled up from the bottom; 0 follows new rows
    this.lastDraw = 0;
  }

  onScroll(amount) {
    this.scroll = Math.max(0, this.scroll + amount * 40);
    this.markDirty();
  }

  // Keep the spinner and timers moving while there is something to watch.
  update() {
    const c = this.getConversation();
    const busy = c && (c.state === 'working' || c.state === 'waiting' || (c.tasks ?? []).some((t) => t.status === 'running'));
    if (busy && this.clock() - this.lastDraw >= REDRAW_MS) this.markDirty();
    if (this.armed && this.clock() > this.armed.until) { this.armed = null; this.markDirty(); }
    super.update();
  }

  spotAt(h) {
    if (!h) return null;
    const x = h.u * this.pxW;
    const y = h.v * this.pxH;
    return this.spots.find((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) ?? null;
  }

  setHover(uv) {
    super.setHover(uv);
    const s = this.spotAt(this.hover);
    if (s !== this.hoverSpot) { this.hoverSpot = s; this.markDirty(); }
  }

  onClick(h) { this.spotAt(h)?.act(); }

  // Stop on a worker takes two taps within a few seconds, so a stray tap cannot end its work.
  tapStop(id) {
    if (this.armed?.id === id && this.clock() <= this.armed.until) { this.armed = null; this.client?.stopTask(id); } else this.armed = { id, until: this.clock() + CONFIRM_MS };
    this.markDirty();
  }

  // The background workers, under the status line. Returns how much height they took.
  drawWorkers(ctx, c, now, w, y0) {
    const rows = backgroundRows(c, now);
    this.spots = [];
    if (!rows.length) return 0;
    const shown = rows.slice(0, MAX_WORKERS_SHOWN);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7d8da2';
    ctx.font = `600 24px ${SANS}`;
    ctx.fillText(`WORKERS${rows.length > shown.length ? `  (+${rows.length - shown.length} more)` : ''}`, PAD, y0 + WORKERS_TITLE_H / 2 + 4);
    shown.forEach((r, i) => {
      const y = y0 + WORKERS_TITLE_H + i * WORKER_H;
      const cy = y + 24;
      this.mark(ctx, r.status === 'running' ? 'running' : r.status === 'completed' ? 'ok' : 'error', PAD, cy, now);
      const time = r.ms === null ? '' : fmtDuration(r.ms);
      const stopW = r.status === 'running' && this.client ? 130 : 0;
      ctx.font = `600 26px ${SANS}`;
      ctx.fillStyle = r.status === 'running' ? '#e6edf5' : '#9fb0c4';
      ctx.textAlign = 'left';
      ctx.fillText(this.fit(ctx, r.text, w - PAD * 2 - 52 - stopW - (time ? 110 : 0)), PAD + 50, cy);
      if (time) { ctx.font = `24px ${MONO}`; ctx.fillStyle = '#7d8da2'; ctx.textAlign = 'right'; ctx.fillText(time, w - PAD - stopW - 8, cy); ctx.textAlign = 'left'; }
      ctx.font = `22px ${MONO}`;
      ctx.fillStyle = '#7d8da2';
      const sub = r.status === 'running' ? (r.last ? `using ${r.last}` : 'starting') : r.status === 'completed' ? (r.summary || 'finished') : r.status;
      ctx.fillText(this.fit(ctx, sub, w - PAD * 2 - 50), PAD + 50, y + 56);
      if (stopW) {
        const armed = this.armed?.id === r.id;
        const spot = { x: w - PAD - stopW + 4, y: y + 2, w: stopW - 8, h: 44, act: () => this.tapStop(r.id) };
        this.spots.push(spot);
        ctx.fillStyle = armed ? '#8a2f2f' : this.hoverSpot === spot ? '#2d3f57' : '#1d2733';
        roundRect(ctx, spot.x, spot.y, spot.w, spot.h, 12);
        ctx.fill();
        ctx.fillStyle = '#e6edf5';
        ctx.font = `600 24px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.fillText(armed ? 'Stop?' : 'Stop', spot.x + spot.w / 2, spot.y + spot.h / 2 + 1);
        ctx.textAlign = 'left';
      }
    });
    return WORKERS_TITLE_H + shown.length * WORKER_H + 8;
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

    // ---- background workers ---------------------------------------------------------
    const workersH = this.drawWorkers(ctx, c, now, w, HEAD_H + 6);

    // ---- rows, newest at the bottom -------------------------------------------------
    const rows = activityRows(c, now);
    const top = HEAD_H + 10 + workersH;
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
