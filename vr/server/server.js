// vr-hub: serves the WebXR client and its small API. No dependencies.
//
// Runs behind Traefik+Authelia (Traefik strips the /vr prefix), so every
// request that reaches here is already authenticated and carries a
// Remote-User header. Like the gateway's ttyd, the port is never published
// directly, so that header can be trusted. /api/* still refuses requests
// without it, so a misrouted deployment fails closed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
// Two client sources: the copy baked into the image, and a live-edit overlay
// volume that vr-sync writes (with a .synced timestamp). Newest wins: a deploy
// after your last sync serves the image; a sync after the deploy serves the overlay.
const BAKED_DIR = process.env.BAKED_CLIENT_DIR || '/app/client-default';
const BUILT_FILE = process.env.BUILT_STAMP_FILE || '/app/client-built';
const CLIENT_DIR = process.env.CLIENT_DIR || '/srv/client';
const MODULES_DIR = process.env.MODULES_DIR || path.join(here, '..', 'node_modules');

// Where the browser should open the ttyd websocket. In path mode this is
// same-origin '/ws'; if the hub ever moves to its own subdomain, set this to
// 'wss://claude.frustrated.blog/ws' and nothing else changes.
const TTYD_URL = process.env.TTYD_URL || '/ws';
// Agent view websocket (served by the gateway) and the directory Claude starts in.
const AGENT_URL = process.env.AGENT_URL || '/agent/ws';
const AGENT_CWD = process.env.AGENT_CWD || '';

// Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint. Point
// STT_URL at a self-hosted whisper server to swap providers without code changes.
const STT_URL = process.env.STT_URL || 'https://api.openai.com/v1/audio/transcriptions';
const STT_KEY = process.env.STT_API_KEY || '';
const STT_MODEL = process.env.STT_MODEL || 'whisper-1';
// Vocabulary hint: the recogniser leans toward these spellings, which is what
// stops "Claude" coming out as "clawed". Override with STT_PROMPT.
const STT_PROMPT = process.env.STT_PROMPT
  ?? 'Claude, Claude Code, Anthropic, tmux, git, GitHub, Docker, npm, sudo, ssh, ttyd, Traefik, Authelia, WebXR.';
const STT_LANGUAGE = process.env.STT_LANGUAGE || 'en';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// Text-to-speech for spoken replies, for browsers (the Quest's) with no speech
// engine of their own. Any OpenAI-compatible /audio/speech endpoint; by default
// the same provider and key as speech-to-text. TTS_ENABLED=0 turns it off.
const TTS_URL = process.env.TTS_URL || STT_URL.replace(/\/audio\/transcriptions$/, '/audio/speech');
const TTS_KEY = process.env.TTS_API_KEY || STT_KEY;
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';
const TTS_ENABLED = process.env.TTS_ENABLED !== '0' && Boolean(TTS_KEY);
const MAX_TTS_CHARS = 600;

function readStamp(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

let lastSource = null;
function clientDir() {
  const synced = readStamp(path.join(CLIENT_DIR, '.synced'));
  const built = readStamp(BUILT_FILE) ?? 0;
  const source = synced !== null && synced > built ? CLIENT_DIR : BAKED_DIR;
  if (source !== lastSource) {
    console.log(`serving client from ${source === CLIENT_DIR ? 'live overlay (vr-sync)' : 'image'}`);
    lastSource = source;
  }
  return source;
}

// Libraries served from the image's node_modules, mapped by the client's importmap.
const VENDOR = {
  '/vendor/three/': path.join(MODULES_DIR, 'three'),
  '/vendor/xterm-headless.mjs': path.join(MODULES_DIR, '@xterm/headless/lib-headless/xterm-headless.mjs'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

// Resolve urlPath under root, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  const full = path.normalize(path.join(root, decodeURIComponent(urlPath)));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function transcribe(req, res) {
  if (!STT_KEY) return sendJson(res, 503, { error: 'STT_API_KEY is not configured on the hub' });
  const audio = await readBody(req, MAX_AUDIO_BYTES);
  if (!audio.length) return sendJson(res, 400, { error: 'empty audio' });

  const mime = (req.headers['content-type'] || 'audio/webm').split(';')[0];
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `speech.${ext}`);
  form.append('model', STT_MODEL);
  form.append('response_format', 'json');
  if (STT_LANGUAGE) form.append('language', STT_LANGUAGE);
  if (STT_PROMPT) form.append('prompt', STT_PROMPT);

  const started = performance.now();
  const upstream = await fetch(STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STT_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!upstream.ok) {
    console.error('stt upstream', upstream.status, (await upstream.text()).slice(0, 200));
    return sendJson(res, 502, { error: `speech service returned ${upstream.status}` });
  }
  const { text = '' } = await upstream.json();
  const ms = Math.round(performance.now() - started);
  console.log(`stt ${audio.length}B in ${ms}ms via ${STT_MODEL}`);
  sendJson(res, 200, { text: text.trim(), ms });
}

async function speak(req, res) {
  if (!TTS_ENABLED) return sendJson(res, 503, { error: 'text-to-speech is not configured on the hub' });
  let text;
  try { text = String(JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')).text ?? '').trim(); } catch { text = ''; }
  if (!text) return sendJson(res, 400, { error: 'no text' });
  if (text.length > MAX_TTS_CHARS) return sendJson(res, 413, { error: `text longer than ${MAX_TTS_CHARS} characters` });

  const started = performance.now();
  const upstream = await fetch(TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TTS_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'mp3' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!upstream.ok) {
    console.error('tts upstream', upstream.status, (await upstream.text()).slice(0, 200));
    return sendJson(res, 502, { error: `speech service returned ${upstream.status}` });
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  console.log(`tts ${text.length} chars -> ${audio.length}B in ${Math.round(performance.now() - started)}ms via ${TTS_MODEL}`);
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
  res.end(audio);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://hub');
    const p = url.pathname;

    if (p === '/healthz') return send(res, 200, 'ok');

    if (p.startsWith('/api/')) {
      const user = req.headers['remote-user'];
      if (!user) return sendJson(res, 401, { error: 'unauthenticated' });
      if (p === '/api/whoami' && req.method === 'GET') return sendJson(res, 200, { user });
      if (p === '/api/stt' && req.method === 'POST') return await transcribe(req, res);
      if (p === '/api/tts' && req.method === 'POST') return await speak(req, res);
      return sendJson(res, 404, { error: 'not found' });
    }

    if (p === '/config.json') {
      return sendJson(res, 200, { ttydUrl: TTYD_URL, agentUrl: AGENT_URL, agentCwd: AGENT_CWD, sttEnabled: Boolean(STT_KEY), ttsEnabled: TTS_ENABLED });
    }

    for (const [prefix, target] of Object.entries(VENDOR)) {
      if (p === prefix || (prefix.endsWith('/') && p.startsWith(prefix))) {
        const file = prefix.endsWith('/') ? safeJoin(target, p.slice(prefix.length)) : target;
        return file ? serveFile(res, file) : send(res, 404, 'not found');
      }
    }

    const file = safeJoin(clientDir(), p === '/' ? '/index.html' : p);
    return file ? serveFile(res, file) : send(res, 404, 'not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`vr-hub listening on :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
