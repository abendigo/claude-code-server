// Microphone capture + server-side transcription. The mic stream must be
// opened from a normal page gesture (permission prompts don't work inside an
// immersive session), so init() is called from the "Enter VR" click; after
// that, start()/stop() just toggle the already-open track.
const TAIL_MS = 300; // keep recording briefly after release so words aren't clipped

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Voice {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.recording = false;
  }

  get ready() { return Boolean(this.stream); }

  async init() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.setLive(false);
  }

  setLive(on) { this.stream.getAudioTracks().forEach((t) => { t.enabled = on; }); }

  start() {
    if (!this.stream || this.recording) return false;
    this.chunks = [];
    this.setLive(true);
    this.rec = new MediaRecorder(this.stream, { mimeType: pickMime() || undefined });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this.recording = true;
    return true;
  }

  // Resolves with the recorded Blob.
  stop() {
    return new Promise((resolve) => {
      if (!this.recording) return resolve(new Blob([]));
      this.recording = false;
      setTimeout(() => {
        this.rec.onstop = () => {
          this.setLive(false);
          resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' }));
        };
        this.rec.stop();
      }, TAIL_MS);
    });
  }

  async transcribe(blob) {
    if (blob.size < 2000) return ''; // nothing but silence/click
    const res = await fetch('api/stt', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `speech service error ${res.status}`);
    return body.text;
  }
}
