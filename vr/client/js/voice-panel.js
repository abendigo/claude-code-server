// Dictation bar: record -> transcribe -> REVIEW -> send. Nothing reaches a
// terminal until you confirm, so a mis-heard word never runs as a command.
import { Panel, roundRect, wrapText } from './panel.js';

const FONT = 'ui-sans-serif, system-ui, sans-serif';

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
    this.error = sttEnabled ? '' : 'Speech-to-text is not configured on the server (STT_API_KEY).';
    this.hoverIdx = -1;
  }

  buttons() {
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
  }

  rects() {
    const bs = this.buttons();
    const gap = 20;
    const bw = (this.pxW - 40 - gap * (bs.length - 1)) / bs.length;
    return bs.map((b, i) => ({ ...b, x: 20 + i * (bw + gap), y: this.pxH - 150, w: bw, h: 130 }));
  }

  indexAt(h) {
    if (!h) return -1;
    const x = h.u * this.pxW;
    const y = h.v * this.pxH;
    return this.rects().findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  setHover(uv) {
    super.setHover(uv);
    const idx = this.indexAt(this.hover);
    if (idx !== this.hoverIdx) { this.hoverIdx = idx; this.markDirty(); }
  }

  onClick(h) {
    const idx = this.indexAt(h);
    if (idx >= 0) this.rects()[idx].act();
  }

  startRecording() {
    if (!this.voice.ready) { this.fail('Microphone not available. Allow it, then re-enter VR.'); return; }
    if (this.voice.start()) { this.state = 'recording'; this.text = ''; this.error = ''; this.markDirty(); }
  }

  async stopRecording() {
    if (this.state !== 'recording') return;
    this.state = 'transcribing';
    this.markDirty();
    try {
      const blob = await this.voice.stop();
      this.text = await this.voice.transcribe(blob);
      this.state = this.text ? 'review' : 'idle';
      if (!this.text) this.error = 'Nothing heard.';
    } catch (e) {
      this.fail(e.message);
      return;
    }
    this.markDirty();
  }

  fail(msg) { this.error = msg; this.state = 'error'; this.markDirty(); }

  reset() { this.state = 'idle'; this.text = ''; this.error = ''; this.markDirty(); }

  confirm(enter) {
    const target = this.getTarget();
    if (target && this.text) {
      target.paste(this.text);
      if (enter) target.send('\r');
    }
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
      idle: 'Hold A (right controller) or press Talk',
      recording: '● Recording - release A or press Stop',
      transcribing: 'Transcribing...',
      review: `Review, then send to ${target ? target.name : 'no terminal focused'}`,
      error: 'Problem',
    }[this.state];
    ctx.fillStyle = this.state === 'recording' ? '#ff6b6b' : '#8b9bb0';
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText(header, 30, 24);

    ctx.fillStyle = this.state === 'error' ? '#ffb3b3' : '#e6edf5';
    ctx.font = `44px ${FONT}`;
    const body = this.state === 'review' ? this.text : this.state === 'error' || this.error ? this.error : '';
    wrapText(ctx, body, w - 60).slice(0, 5).forEach((line, i) => ctx.fillText(line, 30, 80 + i * 56));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.rects().forEach((r, i) => {
      ctx.fillStyle = i === this.hoverIdx ? '#3b6ea8' : '#244a73';
      roundRect(ctx, r.x, r.y, r.w, r.h, 20);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 52px ${FONT}`;
      ctx.fillText(r.label, r.x + r.w / 2, r.y + r.h / 2);
    });
    ctx.textAlign = 'left';
  }
}
