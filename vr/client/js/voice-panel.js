// Dictation bar: record -> transcribe -> clean up -> (review) -> send.
// Recording stops by itself when you stop talking. Two toggles:
//   Mode  Command | Prompt : shell-friendly text vs prose for Claude (transcript.js)
//   After Review | Direct  : confirm before sending, or paste straight away
// Nothing is ever followed by Enter automatically except via "Send + Enter",
// so a mis-heard word can't run as a command on its own.
import { Panel, roundRect, wrapText } from './panel.js';
import { cleanTranscript, approvalIntent } from './transcript.js';

const FONT = 'ui-sans-serif, system-ui, sans-serif';
const HOLD_MS = 450; // A held longer than this is push-to-talk; a tap leaves recording running

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

export class VoicePanel extends Panel {
  // getTarget(): the currently focused TerminalPanel (or null).
  constructor({ voice, getTarget, sttEnabled, widthM = 1.1 }) {
    const pxW = 1500;
    const pxH = 520;
    super({ widthM, heightM: (widthM * pxH) / pxW, pxW, pxH, name: 'voice' });
    this.voice = voice;
    this.getTarget = getTarget;
    this.state = sttEnabled ? 'idle' : 'error';
    this.text = '';
    this.note = '';
    this.error = sttEnabled ? '' : 'Speech-to-text is not configured on the server (STT_API_KEY).';
    this.mode = load('vr.voice.mode', 'command');
    this.direct = load('vr.voice.direct', '0') === '1';
    this.hoverIdx = -1;
    this.pttDownAt = 0;
    this.pttStarted = false;
  }

  buttons() {
    const state = (() => {
      switch (this.state) {
        case 'idle': return [{ label: 'Talk', act: () => this.startRecording() }];
        case 'recording': return [{ label: 'Stop', act: () => this.stopRecording() }];
        case 'review': return [
          { label: 'Send + Enter', act: () => this.confirm(true) },
          { label: 'Send', act: () => this.confirm(false) },
          { label: 'Redo', act: () => this.startRecording() },
          { label: 'Discard', act: () => this.reset() },
        ];
        case 'error': return this.voice.ready ? [{ label: 'OK', act: () => this.reset() }] : [];
        default: return [];
      }
    })();
    const bw = (this.pxW - 40 - 20 * Math.max(state.length - 1, 0)) / Math.max(state.length, 1);
    const bottom = state.map((b, i) => ({ ...b, x: 20 + i * (bw + 20), y: this.pxH - 150, w: bw, h: 130, big: true }));
    // Talking to Claude is always prose, so the terminal-only Command/Prompt switch doesn't apply.
    const chat = Boolean(this.getTarget()?.voiceSubmits);
    const toggles = [
      { label: chat ? 'Mode: Chat' : `Mode: ${this.mode === 'command' ? 'Command' : 'Prompt'}`, act: () => (chat ? null : this.toggleMode()), x: this.pxW - 640, y: 14, w: 300, h: 64 },
      { label: `After: ${this.direct ? 'Direct' : 'Review'}`, act: () => this.toggleDirect(), x: this.pxW - 330, y: 14, w: 310, h: 64 },
    ];
    return [...bottom, ...toggles];
  }

  indexAt(h) {
    if (!h) return -1;
    const x = h.u * this.pxW;
    const y = h.v * this.pxH;
    return this.buttons().findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  setHover(uv) {
    super.setHover(uv);
    const idx = this.indexAt(this.hover);
    if (idx !== this.hoverIdx) { this.hoverIdx = idx; this.markDirty(); }
  }

  onClick(h) {
    const idx = this.indexAt(h);
    if (idx >= 0) this.buttons()[idx].act();
  }

  toggleMode() {
    this.mode = this.mode === 'command' ? 'prompt' : 'command';
    save('vr.voice.mode', this.mode);
    this.markDirty();
  }

  toggleDirect() {
    this.direct = !this.direct;
    save('vr.voice.direct', this.direct ? '1' : '0');
    this.markDirty();
  }

  // Controller button: a tap starts recording (it stops itself on silence, or
  // tap again to stop); holding is push-to-talk and stops on release.
  pttDown() {
    this.pttDownAt = performance.now();
    if (this.state === 'recording') { this.pttStarted = false; this.stopRecording(); return; }
    if (this.state === 'review' || this.state === 'idle' || this.state === 'error') {
      if (this.state === 'error' && !this.voice.ready) return;
      this.pttStarted = this.startRecording();
    }
  }

  pttUp() {
    if (this.pttStarted && performance.now() - this.pttDownAt > HOLD_MS) this.stopRecording();
    this.pttStarted = false;
  }

  startRecording() {
    if (!this.voice.ready) { this.fail('Microphone not available. Allow it, then re-enter VR.'); return false; }
    const ok = this.voice.start((reason) => {
      if (reason === 'silence') this.stopRecording();
      else this.cancel("Didn't hear anything.");
    });
    if (ok) { this.state = 'recording'; this.text = ''; this.error = ''; this.note = ''; this.markDirty(); }
    return ok;
  }

  cancel(msg) {
    this.voice.stop();
    this.state = 'idle';
    this.note = msg;
    this.markDirty();
  }

  async stopRecording() {
    if (this.state !== 'recording') return;
    this.state = 'transcribing';
    this.markDirty();
    const t0 = performance.now();
    try {
      const blob = await this.voice.stop();
      const { text, ms } = await this.voice.transcribe(blob);
      const secs = (v) => (v / 1000).toFixed(1);
      this.note = `speech service ${secs(ms)}s, total ${secs(performance.now() - t0)}s`;
      const target = this.getTarget();
      // While Claude is waiting for an answer, "yes" / "no" / "always allow" are
      // answers, not messages. Handled before anything else.
      const intent = target?.pendingPermission ? approvalIntent(text) : null;
      if (intent) {
        target.answerPermission(intent);
        this.state = 'idle';
        this.note = `${{ allow: 'Allowed', always: 'Always allowed', deny: 'Denied' }[intent]} (${this.note})`;
        this.markDirty();
        return;
      }
      // Talking to Claude is prose; the Command-mode shell clean-up is only for terminals.
      this.text = cleanTranscript(text, target?.voiceSubmits ? 'prompt' : this.mode);
      if (!this.text) { this.state = 'idle'; this.note = "Didn't catch that. " + this.note; }
      else if (this.direct) { this.deliver(false); this.state = 'idle'; this.note = `Sent "${this.text}" (${this.note})`; }
      else this.state = 'review';
    } catch (e) {
      this.fail(e.message);
      return;
    }
    this.markDirty();
  }

  fail(msg) { this.error = msg; this.state = 'error'; this.markDirty(); }

  reset() { this.state = 'idle'; this.text = ''; this.error = ''; this.note = ''; this.markDirty(); }

  deliver(enter) {
    const target = this.getTarget();
    if (!target || !this.text) return;
    // A conversation takes dictation as a message; a terminal gets keystrokes.
    if (target.voiceSubmits) { target.submit(this.text); return; }
    target.paste(this.text);
    if (enter) target.send('\r');
  }

  confirm(enter) {
    this.deliver(enter);
    this.reset();
  }

  draw(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(14,18,24,0.94)';
    roundRect(ctx, 0, 0, w, h, 28);
    ctx.fill();
    ctx.textBaseline = 'top';

    const target = this.getTarget();
    const header = {
      idle: 'Tap A or press Talk (hold A = push to talk)',
      recording: '● Listening... stops when you stop talking',
      transcribing: 'Transcribing...',
      review: `Review, then send to ${target ? target.name : 'no terminal focused'}`,
      error: 'Problem',
    }[this.state];
    ctx.fillStyle = this.state === 'recording' ? '#ff6b6b' : '#8b9bb0';
    ctx.font = `600 32px ${FONT}`;
    ctx.fillText(header, 30, 28);

    ctx.fillStyle = this.state === 'error' ? '#ffb3b3' : '#e6edf5';
    ctx.font = `44px ${FONT}`;
    const body = this.state === 'review' ? this.text : this.state === 'error' ? this.error : this.note;
    if (this.state !== 'idle' || this.note) {
      if (this.state === 'idle') { ctx.fillStyle = '#8b9bb0'; ctx.font = `34px ${FONT}`; }
      wrapText(ctx, body, w - 60).slice(0, 4).forEach((line, i) => ctx.fillText(line, 30, 110 + i * 56));
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.buttons().forEach((r, i) => {
      ctx.fillStyle = i === this.hoverIdx ? '#3b6ea8' : r.big ? '#244a73' : '#1d2733';
      roundRect(ctx, r.x, r.y, r.w, r.h, r.big ? 20 : 14);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${r.big ? 52 : 30}px ${FONT}`;
      ctx.fillText(r.label, r.x + r.w / 2, r.y + r.h / 2);
    });
    ctx.textAlign = 'left';
  }
}
