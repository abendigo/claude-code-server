import test from 'node:test';
import assert from 'node:assert/strict';

const storage = {};
globalThis.localStorage = { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };

const { Speaker } = await import('../client/js/speech.js');
const { splitSpoken, speakable, fallbackSpoken } = await import('../client/js/spoken.js');

// A speech engine that records what it was asked to say.
function engine(voices = []) {
  const synth = {
    spoken: [], cancels: 0,
    getVoices: () => voices,
    speak(u) { this.spoken.push(u); },
    cancel() { this.cancels++; },
  };
  class Utterance { constructor(text) { this.text = text; } }
  return { synth, Utterance };
}
const speaker = (e, opts = {}) => { for (const k of Object.keys(storage)) delete storage[k]; return new Speaker({ ...e, lang: 'en-US', ...opts }); };

test('say speaks, and a newer utterance replaces the one in progress', () => {
  const e = engine();
  const s = speaker(e);
  assert.equal(s.say('one'), true);
  assert.equal(s.speaking, true);
  const first = e.synth.spoken[0];
  s.say('two');
  assert.deepEqual(e.synth.spoken.map((u) => u.text), ['one', 'two']);
  assert.equal(e.synth.cancels, 1);
  first.onend(); // the cancelled one finishing late must not clear the new one
  assert.equal(s.speaking, true);
  e.synth.spoken[1].onend();
  assert.equal(s.speaking, false);
});

test('turning it off stops speech and is remembered', () => {
  const e = engine();
  const s = speaker(e);
  s.say('hello');
  s.toggle();
  assert.equal(s.speaking, false);
  assert.equal(s.say('quiet'), false);
  assert.equal(e.synth.spoken.length, 1);
  assert.equal(storage['vr.speak'], '0');
  assert.equal(new Speaker({ ...e }).enabled, false);
  s.toggle();
  assert.equal(s.say('back'), true);
});

test('stays quiet while held (microphone open) and when there is no speech engine', () => {
  const e = engine();
  const s = speaker(e);
  s.hold = () => true;
  assert.equal(s.say('x'), false);
  assert.equal(e.synth.spoken.length, 0);
  const none = speaker({ synth: undefined, Utterance: undefined });
  assert.equal(none.available, false);
  assert.equal(none.say('x'), false);
  assert.doesNotThrow(() => none.stop());
});

test('prefers an installed voice in the browser language', () => {
  const voices = [{ lang: 'de-DE', localService: true }, { lang: 'en-GB', localService: false }, { lang: 'en-US', localService: true }];
  const e = engine(voices);
  speaker(e).say('hi');
  assert.equal(e.synth.spoken[0].voice, voices[2]);
  assert.equal(e.synth.spoken[0].lang, 'en-US');
});

test('splitSpoken separates the summary and hides a tag still streaming in', () => {
  assert.deepEqual(splitSpoken('Done.\n\n<spoken>I fixed it.</spoken>'), { text: 'Done.', spoken: 'I fixed it.' });
  assert.deepEqual(splitSpoken('No tag here'), { text: 'No tag here', spoken: null });
  assert.equal(splitSpoken('Done.\n<spoken>I fix').text, 'Done.');
  assert.equal(splitSpoken('Done.\n<spo').text, 'Done.');
  assert.equal(splitSpoken('Done.\n<').text, 'Done.');
  assert.equal(splitSpoken('<spoken></spoken>').spoken, null);
});

test('speakable drops code, links and markdown, and keeps it short', () => {
  assert.equal(speakable('## Result\n- **fast** and `ok`\n```js\nconst x = 1;\n```\nSee https://x.test/a?b=1 now'), 'Result fast and ok See a link now');
  const long = 'Sentence number one is here. '.repeat(30);
  const out = speakable(long, 100);
  assert.ok(out.length <= 100 && out.endsWith('.'), out);
});

test('fallbackSpoken is the first two sentences', () => {
  assert.equal(fallbackSpoken('First one. Second one! Third one? Fourth.'), 'First one. Second one!');
  assert.equal(fallbackSpoken('```\nonly code\n```'), '');
  assert.equal(fallbackSpoken('Edited index.js and ran tests. All pass.'), 'Edited index.js and ran tests. All pass.');
});

// ---- hub-generated speech (browsers with no speech engine of their own) -----------------------------
globalThis.URL.createObjectURL ??= () => 'blob:fake';
globalThis.URL.revokeObjectURL ??= () => {};

function remoteRig({ status = 200, body = { error: 'boom' }, playFails = false } = {}) {
  const rig = { calls: [], audios: [], resolve: null };
  rig.fetch = (url, init) => {
    rig.calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      rig.resolve = () => resolve({ ok: status === 200, status, blob: async () => new Blob(['mp3']), arrayBuffer: async () => new ArrayBuffer(4), json: async () => body });
    });
  };
  rig.Audio = class { constructor(url) { this.url = url; this.paused = false; rig.audios.push(this); } play() { return playFails ? Promise.reject(new Error('blocked')) : Promise.resolve(); } pause() { this.paused = true; } };
  const errors = [];
  rig.errors = errors;
  rig.make = () => { for (const k of Object.keys(storage)) delete storage[k]; return new Speaker({ synth: undefined, Utterance: undefined, remote: { url: 'api/tts', fetch: rig.fetch, Audio: rig.Audio, AudioContext: rig.AudioContext }, onError: (m) => errors.push(m) }); };
  return rig;
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('with no browser engine, speech is fetched from the hub and played', async () => {
  const r = remoteRig();
  const s = r.make();
  assert.equal(s.local, false);
  assert.equal(s.available, true);
  assert.equal(s.say('All done.'), true);
  assert.deepEqual([r.calls[0].url, r.calls[0].body], ['api/tts', { text: 'All done.' }]);
  assert.equal(s.speaking, true); // Hush is available while the audio is being fetched
  r.resolve();
  await settle();
  assert.equal(r.audios.length, 1);
  r.audios[0].onended();
  assert.equal(s.speaking, false);
  assert.deepEqual(r.errors, []);
});

test('stopping, or a newer utterance, drops audio that has not arrived yet', async () => {
  const r = remoteRig();
  const s = r.make();
  s.say('first');
  s.stop();
  assert.equal(r.calls[0].signal.aborted, true);
  assert.equal(s.speaking, false);
  s.say('second');
  r.resolve();
  await settle();
  assert.equal(r.audios.length, 1); // only the second one plays
  s.say('third'); // replaces the one playing
  assert.equal(r.audios[0].paused, true);
});

test('a hub or playback failure is reported once, and speaking ends', async () => {
  const a = remoteRig({ status: 503, body: { error: 'text-to-speech is not configured on the hub' } });
  const s = a.make();
  s.say('hello');
  a.resolve();
  await settle();
  assert.deepEqual(a.errors, ['Spoken reply failed: text-to-speech is not configured on the hub']);
  assert.equal(s.speaking, false);
  const b = remoteRig({ playFails: true });
  const t = b.make();
  t.say('hello');
  b.resolve();
  await settle();
  assert.match(b.errors[0], /blocked/);
  assert.equal(t.speaking, false);
});

test('a browser engine, when there is one, wins over the hub', () => {
  const e = engine();
  const r = remoteRig();
  for (const k of Object.keys(storage)) delete storage[k];
  const s = new Speaker({ ...e, remote: { url: 'api/tts', fetch: r.fetch, Audio: r.Audio } });
  s.say('hi');
  assert.equal(e.synth.spoken.length, 1);
  assert.equal(r.calls.length, 0);
});

test('with an AudioContext, unlock() starts it and speech plays through it, not an Audio element', async () => {
  const r = remoteRig();
  const log = [];
  r.AudioContext = class {
    constructor() { this.destination = {}; log.push('new'); }
    resume() { log.push('resume'); return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { const src = { connect() {}, start: () => log.push('start'), stop: () => log.push('stop') }; r.sources.push(src); return src; }
    decodeAudioData(d) { log.push(`decode ${d.byteLength}`); return Promise.resolve({ decoded: true }); }
  };
  r.sources = [];
  const s = r.make();
  s.unlock();
  s.unlock();
  assert.equal(log.filter((x) => x === 'new').length, 1);
  assert.equal(s.say('Hello.'), true);
  r.resolve();
  await settle();
  assert.equal(r.audios.length, 0);
  const src = r.sources.at(-1);
  assert.deepEqual(src.buffer, { decoded: true });
  assert.equal(s.speaking, true);
  s.stop();
  assert.equal(s.speaking, false);
  assert.ok(log.includes('stop'));
  assert.deepEqual(r.errors, []);
});
