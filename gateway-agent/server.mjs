// agent-gateway: lets the VR client talk to Claude Code running in the user's
// own worker container. Traefik+Authelia authenticate the request and forward
// Remote-User (the port is never published directly -- the same trust model as
// ttyd). For each websocket we run `dispatch-to-worker <user> agent-bridge`,
// which get-or-creates the worker and execs the bridge inside it, and relay
// JSON lines in both directions.
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 7682);
const WS_PATH = '/ws';
const MAX_PER_USER = Number(process.env.AGENT_MAX_PER_USER || 4);
const KILL_AFTER_MS = 5000;
const ALLOWED_FROM_CLIENT = new Set(['prompt', 'permission', 'interrupt', 'login_start', 'login_code', 'login_cancel']);

// Same normalisation as scripts/ttyd-dispatch, so a person lands in the same
// worker whichever front door they use: lowercase, anything outside
// [a-z0-9_.-] becomes '-', collapse repeats, trim separators, 64 chars max.
export function slugify(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 64);
}

// Browsers attach cookies to cross-site websocket handshakes, so without this
// any web page could drive an agent as the logged-in user. A browser always
// sends Origin; require it to match the host we were reached on.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (curl, tests); cross-site pages always send one
  try {
    const allowed = new Set([req.headers.host, req.headers['x-forwarded-host']].filter(Boolean));
    return allowed.has(new URL(origin).host);
  } catch {
    return false;
  }
}

// Full argv for the per-connection process. Overridable so tests can run the
// bridge directly without Docker.
function spawnArgv(slug) {
  if (process.env.AGENT_SPAWN_JSON) return JSON.parse(process.env.AGENT_SPAWN_JSON);
  return ['dispatch-to-worker', slug, 'agent-bridge'];
}

const active = new Map(); // slug -> count

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (code, why) => { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (new URL(req.url, 'http://x').pathname !== WS_PATH) return reject(404, 'Not Found');
  if (!originAllowed(req)) return reject(403, 'Forbidden');
  const slug = slugify(req.headers['remote-user']);
  if (!slug) return reject(401, 'Unauthorized');
  if ((active.get(slug) ?? 0) >= MAX_PER_USER) return reject(429, 'Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => connect(ws, slug));
});

function connect(ws, slug) {
  active.set(slug, (active.get(slug) ?? 0) + 1);
  const argv = spawnArgv(slug);
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  console.log(`agent connect user=${slug} pid=${child.pid}`);
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  // bridge stdout: protocol lines. Anything that isn't a JSON object is surfaced as status text.
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') return send(obj);
    } catch { /* fall through */ }
    send({ type: 'status', text: line });
  });
  // stderr: dispatch progress ("creating environment...") is useful to show; bridge logs are not.
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (!line.trim()) return;
    console.error(`[${slug}] ${line}`);
    if (!line.startsWith('[agent-bridge]')) send({ type: 'status', text: line });
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return send({ type: 'error', message: 'invalid JSON' }); }
    if (!msg || !ALLOWED_FROM_CLIENT.has(msg.type)) return send({ type: 'error', message: 'unknown message type' });
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n');
  });

  // Keepalive: drop peers that vanished (headset asleep, Wi-Fi lost).
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);

  let ended = false;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    clearInterval(ping);
    active.set(slug, Math.max(0, (active.get(slug) ?? 1) - 1));
    // Closing stdin makes the bridge exit cleanly (killing `docker exec` alone
    // would leave it running in the container); the kill is only a backstop.
    child.stdin.end();
    const t = setTimeout(() => child.kill('SIGTERM'), KILL_AFTER_MS);
    child.once('exit', () => clearTimeout(t));
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  child.on('error', (e) => { send({ type: 'error', message: `could not start agent: ${e.message}` }); ws.close(); });
  child.on('exit', (code) => {
    console.log(`agent exit user=${slug} code=${code}`);
    send({ type: 'exit', code });
    cleanup();
    ws.close();
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`agent-gateway listening on :${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { wss.clients.forEach((c) => c.close()); server.close(() => process.exit(0)); });
}
