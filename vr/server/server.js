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
const CLIENT_DIR = process.env.CLIENT_DIR || '/srv/client';
const MODULES_DIR = process.env.MODULES_DIR || path.join(here, '..', 'node_modules');

// Where the browser should open the ttyd websocket. In path mode this is
// same-origin '/ws'; if the hub ever moves to its own subdomain, set this to
// 'wss://claude.frustrated.blog/ws' and nothing else changes.
const TTYD_URL = process.env.TTYD_URL || '/ws';

// Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint. Point
// STT_URL at a self-hosted whisper server to swap providers without code changes.
const STT_URL = process.env.STT_URL || 'https://api.openai.com/v1/audio/transcriptions';
const STT_KEY = process.env.STT_API_KEY || '';
const STT_MODEL = process.env.STT_MODEL || 'whisper-1';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

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
  sendJson(res, 200, { text: text.trim() });
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
      return sendJson(res, 404, { error: 'not found' });
    }

    if (p === '/config.json') {
      return sendJson(res, 200, { ttydUrl: TTYD_URL, sttEnabled: Boolean(STT_KEY) });
    }

    for (const [prefix, target] of Object.entries(VENDOR)) {
      if (p === prefix || (prefix.endsWith('/') && p.startsWith(prefix))) {
        const file = prefix.endsWith('/') ? safeJoin(target, p.slice(prefix.length)) : target;
        return file ? serveFile(res, file) : send(res, 404, 'not found');
      }
    }

    const file = safeJoin(CLIENT_DIR, p === '/' ? '/index.html' : p);
    return file ? serveFile(res, file) : send(res, 404, 'not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`vr-hub listening on :${PORT}, client dir ${CLIENT_DIR}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
