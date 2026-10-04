// Microphone capture + server-side transcription. The mic stream must be
// opened from a normal page gesture (permission prompts don't work inside an
// immersive session), so init() is called from the page before entering VR;
// after that, start()/stop() just toggle the already-open track.
const TAIL_MS = 150;       // keep recording briefly after stop so words aren't clipped
const POLL_MS = 50;
const SILENCE_MS = 1200;   // this long quiet after speech => done talking
const NO_SPEECH_MS = 7000; // never spoke at all => give up
const MIN_THRESHOLD = 0.015;

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
    this.hadSpeech = false;
    this.analyser = null;
    this.vadTimer = null;
  }

  get ready() { return Boolean(this.stream); }

  async init() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.setLive(false);
  }

  setLive(on) { this.stream.getAudioTracks().forEach((t) => { t.enabled = on; }); }

  // onAuto(reason) fires if recording should end by itself: 'silence' after
  // you stop talking, or 'nospeech' if nothing was said.
  start(onAuto) {
    if (!this.stream || this.recording) return false;
    this.ctx.resume?.();
    this.chunks = [];
    this.hadSpeech = false;
    this.setLive(true);
    this.rec = new MediaRecorder(this.stream, { mimeType: pickMime() || undefined });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this.recording = true;
    if (onAuto) this.watch(onAuto);
    return true;
  }

  // Voice-activity detection: adaptive threshold from the first ~300ms of
  // ambient noise, then "speech" = louder than that, "done" = quiet for a while.
  watch(onAuto) {
    const buf = new Float32Array(this.analyser.fftSize);
    const t0 = performance.now();
    let noise = 0, calib = 0, threshold = MIN_THRESHOLD, loud = 0, quietSince = null;
    this.vadTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (calib < 6) { noise += rms; calib++; threshold = Math.max(MIN_THRESHOLD, (noise / calib) * 2.5); return; }
      if (rms > threshold) {
        if (++loud >= 2) this.hadSpeech = true;
        quietSince = null;
      } else {
        loud = 0;
        quietSince ??= now;
        if (this.hadSpeech && now - quietSince > SILENCE_MS) { this.unwatch(); onAuto('silence'); }
      }
      if (!this.hadSpeech && now - t0 > NO_SPEECH_MS) { this.unwatch(); onAuto('nospeech'); }
    }, POLL_MS);
  }

  unwatch() { clearInterval(this.vadTimer); this.vadTimer = null; }

  // Resolves with the recorded Blob.
  stop() {
    this.unwatch();
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

  // Returns {text, ms}: ms is the time the speech service itself took.
  async transcribe(blob) {
    if (blob.size < 2000) return { text: '', ms: 0 }; // nothing but silence/click
    const res = await fetch('api/stt', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `speech service error ${res.status}`);
    return { text: body.text, ms: body.ms ?? 0 };
  }
}
