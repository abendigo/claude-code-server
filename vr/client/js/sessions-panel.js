// The Sessions window: the conversations the session service knows, newest first.
// A dot shows each one's state, the label is the first thing asked, and tapping a
// row switches the Claude window to it (the Activity window follows). New starts
// a fresh session; the old one stays in the list. The cross on a row ends that
// session for good, and asks for a second tap within a few seconds.
// Scrolls like the other windows (onScroll(amount); positive is up).
import { Panel, roundRect } from './panel.js';

const SANS = 'ui-sans-serif, system-ui, sans-serif';
const PAD = 28;
const HEAD_H = 110;
const ROW_H = 104;
const DOT = { idle: '#98c379', working: '#7fb6ff', waiting: '#ffcc66', dormant: '#6f8095', closed: '#ff8a8a' };
const STATE_TEXT = { idle: 'ready', working: 'working', waiting: 'needs your answer', dormant: 'asleep', closed: 'ended' };
const REFRESH_MS = 5000;
const CONFIRM_MS = 3000;

export function age(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export class SessionsPanel extends Panel {
  // client: {listSessions(), switchTo(row), newSession(), closeSession(id), open}
  constructor({ getConversation, client, widthM = 0.7, clock = Date.now }) {
    const pxW = 840;
    const pxH = 1100;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name: 'sessions' });
    this.getConversation = getConversation;
    this.client = client;
    this.clock = clock;
    this.offset = 0; // pixels scrolled down the list
    this.spots = [];
    this.hoverSpot = null;
    this.armed = null; // {id, until}: a session whose cross was tapped once
    this.lastList = 0;
    this.seen = null;
  }

  // The rows to show: this conversation's folder only (terminal sessions from elsewhere stay out).
  rows() {
    const c = this.getConversation();
    if (!c) return [];
    const here = c.attach?.cwd;
    return c.sessions.filter((r) => !here || !r.cwd || r.cwd === here);
  }

  onScroll(amount) {
    this.offset = Math.max(0, this.offset - amount * 40);
    this.markDirty();
  }

  refresh() {
    this.lastList = this.clock();
    this.client.listSessions();
  }

  // Keep the list fresh while it is on screen, and the ages and dots honest.
  update() {
    const c = this.getConversation();
    if (c && this.shown && this.client.open) {
      if (this.clock() - this.lastList >= REFRESH_MS) this.refresh();
      if (c.sessions !== this.seen) { this.seen = c.sessions; this.markDirty(); }
      if (this.armed && this.clock() > this.armed.until) { this.armed = null; this.markDirty(); }
    }
    super.update();
  }

  spotAt(h) {
    if (!h) return null;
    const x = h.u * this.pxW;
    const y = h.v * this.pxH;
    // Later spots are drawn on top (a row's cross sits over the row).
    return [...this.spots].reverse().find((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) ?? null;
  }

  setHover(uv) {
    super.setHover(uv);
    const s = this.spotAt(this.hover);
    if (s !== this.hoverSpot) { this.hoverSpot = s; this.markDirty(); }
  }

  onClick(h) { this.spotAt(h)?.act(); }

  spot(x, y, w, h, act) {
    const s = { x, y, w, h, act };
    this.spots.push(s);
    return s;
  }

  draw(ctx, w, h) {
    const c = this.getConversation();
    const now = this.clock();
    this.spots = [];
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f141b';
    roundRect(ctx, 0, 0, w, h, 28);
    ctx.fill();
    if (!c) return;

    // ---- header ---------------------------------------------------------------------
    ctx.fillStyle = '#151c26';
    roundRect(ctx, 0, 0, w, HEAD_H, 28);
    ctx.fill();
    ctx.fillStyle = '#cfd8e3';
    ctx.font = `600 36px ${SANS}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Sessions', PAD, HEAD_H / 2);
    const nb = this.spot(w - PAD - 150, 22, 150, HEAD_H - 44, () => { this.client.newSession(); this.after(); });
    ctx.fillStyle = this.hoverSpot === nb ? '#2d3f57' : '#1d2733';
    roundRect(ctx, nb.x, nb.y, nb.w, nb.h, 14);
    ctx.fill();
    ctx.fillStyle = '#e6edf5';
    ctx.font = `600 30px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText('New', nb.x + nb.w / 2, nb.y + nb.h / 2 + 1);
    ctx.textAlign = 'left';

    // ---- rows -------------------------------------------------------------------------
    const rows = this.rows();
    const top = HEAD_H + 8;
    const area = h - top - 12;
    const total = rows.length * ROW_H;
    this.offset = Math.min(this.offset, Math.max(0, total - area));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, w, area);
    ctx.clip();
    rows.forEach((r, i) => {
      const y = top + i * ROW_H - this.offset;
      if (y + ROW_H < top || y > top + area) return;
      this.row(ctx, r, y, w, c, now);
    });
    ctx.restore();
    if (!rows.length) {
      ctx.fillStyle = '#6f8095';
      ctx.font = `28px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(this.client.open ? 'No sessions yet.' : 'Not connected.', w / 2, h / 2);
      ctx.textAlign = 'left';
    }
    if (total > area) { // scroll bar
      const thumb = Math.max(40, area * (area / total));
      ctx.fillStyle = '#243040';
      roundRect(ctx, w - 18, top, 8, area, 4);
      ctx.fill();
      ctx.fillStyle = '#4a5a70';
      roundRect(ctx, w - 18, top + (area - thumb) * (this.offset / (total - area)), 8, thumb, 4);
      ctx.fill();
    }
  }

  fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  row(ctx, r, y, w, c, now) {
    const current = Boolean(r.session) && r.session === c.attach?.session;
    const rowSpot = this.spot(10, y + 4, w - 20, ROW_H - 8, () => { if (!current) { this.client.switchTo(r); this.after(); } });
    ctx.fillStyle = current ? '#1f3a5f' : this.hoverSpot === rowSpot ? '#1a2431' : '#131a24';
    roundRect(ctx, rowSpot.x, rowSpot.y, rowSpot.w, rowSpot.h, 16);
    ctx.fill();

    const state = r.state ?? 'dormant';
    ctx.fillStyle = DOT[state] ?? DOT.dormant;
    ctx.beginPath();
    ctx.arc(PAD + 14, y + ROW_H / 2, 12, 0, Math.PI * 2);
    ctx.fill();

    const canClose = Boolean(r.session);
    const crossW = canClose ? 96 : 0;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6edf5';
    ctx.font = `600 29px ${SANS}`;
    ctx.fillText(this.fit(ctx, (r.summary || '(nothing asked yet)').replace(/\s+/g, ' '), w - PAD * 2 - 44 - crossW), PAD + 44, y + ROW_H / 2 - 17);
    ctx.fillStyle = '#8b9bb0';
    ctx.font = `24px ${SANS}`;
    ctx.fillText(`${STATE_TEXT[state] ?? state}${r.lastModified ? ` · ${age(r.lastModified, now)}` : ''}${current ? ' · this one' : ''}${r.viewers > 1 ? ` · ${r.viewers} watching` : ''}`, PAD + 44, y + ROW_H / 2 + 20);

    if (canClose) {
      const armed = this.armed?.id === r.session;
      const cs = this.spot(w - 20 - crossW, y + 14, crossW - 4, ROW_H - 28, () => {
        if (armed) { this.armed = null; this.client.closeSession(r.session); this.after(); } else { this.armed = { id: r.session, until: this.clock() + CONFIRM_MS }; this.markDirty(); }
      });
      ctx.fillStyle = armed ? '#8a2f2f' : this.hoverSpot === cs ? '#2d3f57' : '#1d2733';
      roundRect(ctx, cs.x, cs.y, cs.w, cs.h, 12);
      ctx.fill();
      ctx.fillStyle = '#e6edf5';
      ctx.textAlign = 'center';
      if (armed) { ctx.font = `600 24px ${SANS}`; ctx.fillText('End?', cs.x + cs.w / 2, cs.y + cs.h / 2 + 1); }
      else { // a vector cross: headset fonts may lack the glyph
        const cx = cs.x + cs.w / 2;
        const cy = cs.y + cs.h / 2;
        ctx.strokeStyle = '#e6edf5';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - 11, cy - 11); ctx.lineTo(cx + 11, cy + 11);
        ctx.moveTo(cx + 11, cy - 11); ctx.lineTo(cx - 11, cy + 11);
        ctx.stroke();
      }
      ctx.textAlign = 'left';
    }
  }

  // After something that changes the list, ask for it again shortly.
  after() {
    this.lastList = 0;
    this.markDirty();
  }
}
