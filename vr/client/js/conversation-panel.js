// The conversation with Claude, drawn as a panel: your messages, Claude's
// streaming replies, one-line tool cards, and a dock at the bottom that is
// either an input line or, when Claude asks permission, Allow / Always / Deny.
// Acts as a voice/keyboard target: paste() fills the input, send('\r') submits,
// and voiceSubmits tells the voice bar to send dictation straight in.
import { Panel, roundRect } from './panel.js';
import { Conversation } from './conversation.js';
import { AgentClient } from './agent-client.js';

const SANS = 'ui-sans-serif, system-ui, sans-serif';
const MONO = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
const PAD = 28;
const HEADER_H = 84;
const INPUT_H = 120;
const PERM_H = 330;
const BODY = { font: `32px ${SANS}`, lh: 44 };
const CODE = { font: `27px ${MONO}`, lh: 38 };
const SESSION_KEY = 'vr.agent.session';

const store = {
  get() { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(SESSION_KEY, v) : localStorage.removeItem(SESSION_KEY); } catch { /* optional */ } },
};

// Break text into lines no wider than maxW. Words wrap; a single over-long
// token (a path, a URL) is split by character so it can't overflow.
function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if (ctx.measureText(line + word).width <= maxW) { line += word; continue; }
      if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
      let chunk = '';
      for (const ch of word.trimStart()) {
        if (ctx.measureText(chunk + ch).width > maxW) { lines.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export class ConversationPanel extends Panel {
  constructor({ agentUrl, cwd = '', widthM = 1.5 }) {
    const pxW = 1400;
    const pxH = 1100;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name: 'agent' });
    this.voiceSubmits = true;
    this.cwd = cwd;
    this.input = '';
    this.scroll = 0; // pixels scrolled up from the bottom; 0 follows new text
    this.lines = null; // layout cache, rebuilt when the conversation changes
    this.spots = []; // clickable regions from the last draw
    this.hoverSpot = null;
    this.resumeId = store.get();
    this.convo = new Conversation({
      onChange: (c) => {
        this.lines = null;
        if (c.sessionId) store.set(c.sessionId);
        this.markDirty();
      },
    });
    this.client = new AgentClient(agentUrl, this.convo);
    this.client.connect();
  }

  // ---- voice / keyboard target ------------------------------------------------
  get pendingPermission() { return this.convo.pending; }

  answerPermission(kind) {
    this.client.send(this.convo.answer(kind !== 'deny', kind === 'always'));
  }

  paste(text) {
    this.input += text.replace(/\r\n?/g, '\n');
    this.markDirty();
  }

  send(seq) {
    if (seq === '\r') return this.submit();
    if (seq === '\x7f') this.input = this.input.slice(0, -1);
    else if (seq === '\x1b') this.input = '';
    else if (seq === '\x15') this.input = ''; // Ctrl-U
    else if ([...seq].length === 1 && seq >= ' ') this.input += seq;
    this.markDirty();
  }

  submit(text = this.input) {
    const t = text.trim();
    if (!t) return;
    if (this.convo.state === 'waiting') { // answer the approval first
      this.convo.notice('Answer the approval first: Allow or Deny, or say "yes" or "no".', 'error');
      return;
    }
    const msg = this.convo.submit(t, { cwd: this.cwd, resume: this.resumeId });
    if (this.client.send(msg)) this.resumeId = null; // only the first prompt carries it
    if (text === this.input) this.input = '';
    this.scroll = 0;
    this.markDirty();
  }

  newConversation() {
    this.resumeId = null;
    store.set(null);
    this.client.connect();
    this.scroll = 0;
  }

  resume() {
    const id = store.get();
    if (!id) return;
    this.client.connect();
    this.resumeId = id;
    this.convo.notice('Resuming the previous conversation. Say something to continue.');
  }

  onScroll(amount) {
    this.scroll = Math.max(0, this.scroll + amount * 40);
    this.markDirty();
  }

  // ---- interaction ----------------------------------------------------------------
  spotAt(h) {
    if (!h) return null;
    const x = h.u * this.pxW;
    const y = h.v * this.pxH;
    return this.spots.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) ?? null;
  }

  setHover(uv) {
    super.setHover(uv);
    const s = this.spotAt(this.hover);
    if (s !== this.hoverSpot) { this.hoverSpot = s; this.markDirty(); }
  }

  onClick(h) {
    this.spotAt(h)?.act();
    this.onActivate?.(this);
  }

  // ---- layout ---------------------------------------------------------------------
  buildLines(ctx, width) {
    const out = [];
    const gap = () => out.push({ gap: 16 });
    const push = (text, style, extra = {}) => out.push({ text, font: style.font, lh: style.lh, ...extra });

    for (const b of this.convo.blocks) {
      if (b.kind === 'user') {
        ctx.font = BODY.font;
        push('You', { font: `600 24px ${SANS}`, lh: 34 }, { color: '#7fb6ff' });
        for (const l of wrap(ctx, b.text, width - 40)) push(l, BODY, { color: '#e6edf5', bg: '#16314d', indent: 20 });
      } else if (b.kind === 'assistant') {
        let code = false;
        for (const raw of b.text.split('\n')) {
          if (raw.trim().startsWith('```')) { code = !code; continue; }
          if (code) {
            ctx.font = CODE.font;
            for (const l of wrap(ctx, raw, width - 40)) push(l, CODE, { color: '#c9d7e8', bg: '#0d131a', indent: 20 });
          } else {
            const head = /^(#{1,3})\s+(.*)$/.exec(raw);
            const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
            const style = head ? { font: `600 34px ${SANS}`, lh: 48 } : BODY;
            ctx.font = style.font;
            const text = head ? head[2] : bullet ? bullet[1] : raw;
            wrap(ctx, text, width - (bullet ? 40 : 0)).forEach((l, i) => push((bullet && i === 0 ? '• ' : bullet ? '  ' : '') + l, style, { color: '#e6edf5' }));
          }
        }
        if (b.streaming && out.length) out[out.length - 1].cursor = true;
      } else if (b.kind === 'tool') {
        const color = { running: '#e5c07b', ok: '#98c379', error: '#ff8a8a' }[b.status];
        ctx.font = CODE.font;
        const [first] = wrap(ctx, b.summary, width - 70);
        push(first.length < b.summary.length ? first.slice(0, -1) + '…' : first, CODE, { color, indent: 48, mark: b.status });
      } else if (b.kind === 'permission') {
        const label = { pending: 'waiting for you', allowed: 'allowed', denied: 'denied', cancelled: 'cancelled' }[b.status];
        const color = { pending: '#ffcc66', allowed: '#98c379', denied: '#ff8a8a', cancelled: '#8b9bb0' }[b.status];
        ctx.font = CODE.font;
        const [first] = wrap(ctx, b.text.split('\n').slice(-1)[0] || b.text, width - 260);
        push(`${first}  [${label}]`, CODE, { color, indent: 10 });
      } else {
        ctx.font = BODY.font;
        for (const l of wrap(ctx, b.text, width)) push(l, BODY, { color: b.level === 'error' ? '#ff8a8a' : '#8b9bb0' });
      }
      gap();
    }
    return out;
  }

  // ---- drawing ----------------------------------------------------------------------
  button(ctx, label, x, y, w, h, act, { fill = '#1d2733', hot = '#2d3f57', color = '#e6edf5', font = 30 } = {}) {
    const spot = { x, y, w, h, act, label };
    this.spots.push(spot);
    ctx.fillStyle = this.hoverSpot && this.hoverSpot.x === x && this.hoverSpot.y === y ? hot : fill;
    roundRect(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = `600 ${font}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = 'left';
  }

  // Status marks are vector shapes: the fonts on a headset can't be relied on to
  // have check/cross glyphs, and a missing-glyph box would read as nothing at all.
  drawMark(ctx, kind, x, cy, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (kind === 'ok') { ctx.moveTo(x, cy); ctx.lineTo(x + 8, cy + 9); ctx.lineTo(x + 24, cy - 10); ctx.stroke(); }
    else if (kind === 'error') { ctx.moveTo(x + 2, cy - 10); ctx.lineTo(x + 22, cy + 10); ctx.moveTo(x + 22, cy - 10); ctx.lineTo(x + 2, cy + 10); ctx.stroke(); }
    else for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x + 4 + i * 10, cy + 4, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  draw(ctx, w, h) {
    this.spots = [];
    const c = this.convo;
    const waiting = c.state === 'waiting' && c.pending;
    const dockH = waiting ? PERM_H : INPUT_H;
    const top = HEADER_H;
    const bottom = h - dockH;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(11,15,20,0.96)';
    roundRect(ctx, 0, 0, w, h, 28);
    ctx.fill();
    ctx.textBaseline = 'middle';

    // header
    ctx.fillStyle = this.focused ? '#1f3a5f' : '#161c24';
    roundRect(ctx, 0, 0, w, HEADER_H, 28);
    ctx.fill();
    ctx.fillStyle = '#cfd8e3';
    ctx.font = `600 32px ${SANS}`;
    ctx.fillText('Claude', PAD, HEADER_H / 2);
    const stateText = { offline: 'offline', connecting: 'connecting', idle: 'ready', working: 'working…', waiting: 'needs your answer' }[c.state];
    const stateColor = { offline: '#ff8a8a', connecting: '#e5c07b', idle: '#98c379', working: '#7fb6ff', waiting: '#ffcc66' }[c.state];
    ctx.fillStyle = stateColor;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText(`● ${stateText}`, PAD + 150, HEADER_H / 2);
    let bx = w - PAD;
    const hb = (label, act, wd = 130) => { bx -= wd; this.button(ctx, label, bx, 14, wd, HEADER_H - 28, act, { font: 26 }); bx -= 12; };
    hb('▼', () => { this.scroll = 0; this.markDirty(); }, 70);
    hb('▲', () => this.onScroll(8), 70);
    hb('New', () => this.newConversation(), 100);
    if (store.get() && c.state !== 'working') hb('Resume', () => this.resume(), 130);
    if (c.state === 'working' || waiting) hb('Stop', () => this.client.send({ type: 'interrupt' }), 100);

    // conversation
    if (!this.lines) { ctx.font = BODY.font; this.lines = this.buildLines(ctx, w - PAD * 2); }
    const area = bottom - top - 10;
    const total = this.lines.reduce((s, l) => s + (l.gap ?? l.lh), 0);
    this.scroll = Math.min(this.scroll, Math.max(0, total - area));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, w, area + 10);
    ctx.clip();
    let y = total <= area ? top + 10 : bottom - 10 - total + this.scroll;
    if (!this.lines.length) {
      ctx.fillStyle = '#8b9bb0';
      ctx.font = `32px ${SANS}`;
      const hint = c.status || (c.state === 'connecting' ? 'Connecting…' : 'Say or type what you want Claude to do.\nTap A to talk.');
      hint.split('\n').forEach((l, i) => ctx.fillText(l, PAD, top + 50 + i * 46));
    }
    for (const l of this.lines) {
      if (l.gap) { y += l.gap; continue; }
      if (y + l.lh >= top && y <= bottom) {
        if (l.bg) { ctx.fillStyle = l.bg; ctx.fillRect(PAD - 8, y, w - PAD * 2 + 16, l.lh); }
        ctx.fillStyle = l.color ?? '#e6edf5';
        ctx.font = l.font;
        ctx.fillText(l.text, PAD + (l.indent ?? 0), y + l.lh / 2);
        if (l.mark) this.drawMark(ctx, l.mark, PAD + 12, y + l.lh / 2, l.color);
        if (l.cursor) ctx.fillRect(PAD + (l.indent ?? 0) + ctx.measureText(l.text).width + 6, y + 6, 14, l.lh - 12);
      }
      y += l.lh;
    }
    ctx.restore();
    if (this.scroll > 0) {
      ctx.fillStyle = 'rgba(77,163,255,0.9)';
      ctx.font = `600 24px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillText('▼ newer below', w - PAD, bottom - 22);
      ctx.textAlign = 'left';
    }

    // dock
    ctx.fillStyle = '#121923';
    roundRect(ctx, 10, bottom, w - 20, dockH - 10, 20);
    ctx.fill();
    if (waiting) {
      ctx.fillStyle = '#ffcc66';
      ctx.font = `600 28px ${SANS}`;
      ctx.fillText('Claude wants to:', PAD, bottom + 34);
      ctx.fillStyle = '#e6edf5';
      ctx.font = CODE.font;
      wrap(ctx, c.pending.text, w - PAD * 2).slice(0, 4).forEach((l, i) => ctx.fillText(l, PAD, bottom + 80 + i * 38));
      const by = h - 112;
      const bw = (w - PAD * 2 - 40) / 3;
      this.button(ctx, 'Allow', PAD, by, bw, 90, () => this.answerPermission('allow'), { fill: '#1f5d37', hot: '#2b7d4b', font: 36 });
      this.button(ctx, 'Always allow', PAD + bw + 20, by, bw, 90, () => this.answerPermission('always'), { fill: '#244a73', hot: '#3b6ea8', font: 32 });
      this.button(ctx, 'Deny', PAD + (bw + 20) * 2, by, bw, 90, () => this.answerPermission('deny'), { fill: '#6b2b2b', hot: '#8f3a3a', font: 36 });
    } else {
      ctx.font = `32px ${SANS}`;
      const shown = this.input ? this.input : '';
      const lines = wrap(ctx, shown + (this.focused ? '|' : ''), w - PAD * 2 - 230);
      ctx.fillStyle = this.input ? '#e6edf5' : '#6c7a8c';
      if (!this.input) ctx.fillText('Message Claude…', PAD, bottom + (dockH - 10) / 2);
      else lines.slice(-2).forEach((l, i, a) => ctx.fillText(l, PAD, bottom + (dockH - 10) / 2 - (a.length - 1) * 22 + i * 44));
      this.button(ctx, 'Send', w - PAD - 190, bottom + 14, 170, dockH - 38, () => this.submit(), { fill: '#244a73', hot: '#3b6ea8', font: 32 });
    }

    ctx.lineWidth = 6;
    ctx.strokeStyle = this.focused ? '#4da3ff' : '#2a323d';
    roundRect(ctx, 3, 3, w - 6, h - 6, 26);
    ctx.stroke();
  }
}
