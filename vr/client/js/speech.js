// Spoken replies. What to say is decided elsewhere (spoken.js); this only says
// it, and can be told to stop. Two engines: the browser's own speechSynthesis
// when it has one, otherwise audio fetched from the hub (/api/tts), because the
// Quest's browser has no speech engine. Speaking is always interruptible: a new
// utterance replaces the current one, and the voice bar stops it when you start
// talking. The on/off choice is remembered.
const KEY = 'vr.speak';
const RATE = 1.05;

export class Speaker {
  // remote: {url, Audio?, fetch?, AudioContext?} to enable hub-generated speech when the browser has no engine.
  // With an AudioContext, call unlock() from a click on the flat page: the Quest
  // refuses to start audio from inside an immersive session, but lets a context
  // that was unlocked beforehand keep playing.
  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, lang = globalThis.navigator?.language, remote = null, onChange, onError } = {}) {
    this.synth = synth;
    this.Utterance = Utterance;
    this.lang = lang || 'en-US';
    this.remote = remote && { Audio: globalThis.Audio, AudioContext: globalThis.AudioContext, fetch: globalThis.fetch?.bind(globalThis), ...remote };
    this.ctx = null;
    this.onChange = onChange ?? (() => {});
    this.onError = onError ?? (() => {});
    this.speaking = false;
    this.current = null; // the utterance, or the remote request, in progress
    // Return true to stay quiet right now (e.g. while the microphone is open).
    this.hold = () => false;
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* optional */ }
    this.enabled = saved !== '0';
  }

  get local() { return Boolean(this.synth && this.Utterance); }
  get available() { return this.local || Boolean(this.remote?.url && (this.remote.AudioContext || this.remote.Audio)); }

  // Create the audio context (once) and start it. Must run inside a user gesture.
  unlock() {
    if (this.local || !this.remote?.AudioContext) return;
    try {
      this.ctx ??= new this.remote.AudioContext();
      this.ctx.resume?.();
      // A moment of silence marks the context as user-activated on stricter browsers.
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, 22050);
      src.connect(this.ctx.destination);
      src.start(0);
    } catch (e) { this.onError(`Could not set up audio: ${e.message}`); }
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    try { localStorage.setItem(KEY, this.enabled ? '1' : '0'); } catch { /* optional */ }
    if (!this.enabled) this.stop();
    this.onChange();
  }

  toggle() { this.setEnabled(!this.enabled); }

  // Prefer an installed voice that matches the browser's language.
  pickVoice() {
    const voices = this.synth.getVoices?.() ?? [];
    const base = this.lang.split('-')[0].toLowerCase();
    const mine = voices.filter((v) => v.lang?.toLowerCase().startsWith(base));
    return mine.find((v) => v.lang?.toLowerCase() === this.lang.toLowerCase() && v.localService) ?? mine.find((v) => v.localService) ?? mine[0] ?? null;
  }

  say(text) {
    if (!this.available || !this.enabled || !text || this.hold()) return false;
    if (this.speaking) this.stop();
    if (this.local) this.sayLocal(text); else this.sayRemote(text);
    return true;
  }

  sayLocal(text) {
    const u = new this.Utterance(text);
    const voice = this.pickVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang || this.lang;
    u.rate = RATE;
    const done = () => { if (this.current === u) this.setSpeaking(null); };
    u.onend = done;
    u.onerror = done;
    this.synth.speak(u);
    this.setSpeaking(u);
  }

  // Fetch audio from the hub, then play it. `job` identifies this request, so a
  // reply that arrives after stop() or after a newer utterance is dropped.
  sayRemote(text) {
    const job = { abort: new AbortController(), audio: null, url: null };
    const done = () => { if (this.current === job) this.setSpeaking(null); this.release(job); };
    const fail = (msg) => { if (this.current === job) this.onError(msg); done(); };
    this.setSpeaking(job);
    this.remote.fetch(this.remote.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: job.abort.signal,
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `speech service error ${res.status}`);
      if (this.ctx) {
        const data = await res.arrayBuffer();
        if (this.current !== job) return;
        const buffer = await this.ctx.decodeAudioData(data);
        if (this.current !== job) return;
        await this.ctx.resume?.();
        job.source = this.ctx.createBufferSource();
        job.source.buffer = buffer;
        job.source.connect(this.ctx.destination);
        job.source.onended = done;
        job.source.start(0);
        return;
      }
      const blob = await res.blob();
      if (this.current !== job) return;
      job.url = URL.createObjectURL(blob);
      job.audio = new this.remote.Audio(job.url);
      job.audio.onended = done;
      job.audio.onerror = () => fail('Could not play the spoken reply.');
      await job.audio.play();
    }).catch((e) => { if (e?.name !== 'AbortError') fail(`Spoken reply failed: ${e.message}`); });
  }

  release(job) {
    job.abort.abort();
    if (job.source) { job.source.onended = null; try { job.source.stop(); } catch { /* not started */ } job.source = null; }
    job.audio?.pause?.();
    if (job.url) URL.revokeObjectURL(job.url);
    job.audio = job.url = null;
  }

  stop() {
    if (this.local) this.synth.cancel();
    const job = this.current;
    if (job && !this.local) { this.current = null; this.release(job); }
    this.setSpeaking(null);
  }

  setSpeaking(u) {
    this.current = u;
    const now = Boolean(u);
    if (now !== this.speaking) { this.speaking = now; this.onChange(); }
  }
}
