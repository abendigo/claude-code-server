#!/usr/bin/env node
// agent-service: owns the Claude sessions in a worker, so they outlive the page.
// One per worker, started on demand by `agent-bridge` (see attach.mjs) and left
// running. Pages attach and detach; a session carries on while nobody watches
// (headset off, reload, Wi-Fi gone) and an approval that needs a person waits.
//
// Transport: JSON lines over a unix socket (state dir, mode 0600). Messages the
// old single-session bridge understood still work unchanged: a page that just
// sends `prompt` gets a session of its own that ends with the page.
//
//   page -> service
//     {type:'attach', session?, sdkId?, cwd?}   follow a session (new when neither id is given)
//     {type:'detach'}                           stop following; the session keeps running
//     {type:'list_sessions'}
//     {type:'close_session', session?, sdkId?}  end a session for good: it leaves the list (its transcript is kept)
//     {type:'prompt', text, cwd?, resume?}      a message to the session being followed
//     {type:'permission', id, allow, always?} / {type:'interrupt'} / {type:'stop_task', task}   stop one background worker
//     {type:'login_start'} / {type:'login_code', code} / {type:'login_cancel'}
//   service -> page
//     {type:'attached', session, sdkId, cwd, state, live}
//     {type:'history', messages}                what happened so far, oldest first
//     {type:'sessions', list}
//     {type:'session_state', session, state}   idle | working | waiting
//     {type:'tasks', session, tasks}            the background workers: running first, then the last few finished
//     {type:'user_prompt', text, at}            a message typed in another viewer
//     {type:'sdk', message} / {type:'permission_request', ...} / {type:'permission_cancelled', id}
//     {type:'error', message} / {type:'auth_required'} / {type:'login_url'} / {type:'login_result'} / {type:'closed', session}
//
// `agent-service busy` exits 0 while any session is working or waiting (the idle
// reaper and update-worker ask this before stopping a worker), 1 otherwise.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Session } from './session.mjs';
import { LoginFlow } from './login.mjs';

const HOME = process.env.HOME || '/workspace';
const STATE_DIR = process.env.AGENT_STATE_DIR || path.join(HOME, '.agent');
const SOCKET = process.env.AGENT_SOCKET || path.join(STATE_DIR, 'service.sock');
const MAX_LIVE = Number(process.env.AGENT_MAX_LIVE || 4);
const IDLE_STOP_MS = Number(process.env.AGENT_IDLE_STOP_MS || 30 * 60_000);
const SWEEP_MS = Number(process.env.AGENT_SWEEP_MS || 60_000);
const MAX_LIST = 30;
const PIDFILE = path.join(STATE_DIR, 'service.pid');
const HIDDEN_FILE = path.join(STATE_DIR, 'hidden.json');

// Background workers: slow jobs are handed to a worker so the main session stays free to talk.
// AGENT_WORKERS=0 turns it off; AGENT_WORKER_MODEL picks the workers' model (default: the main one).
const WORKERS = process.env.AGENT_WORKERS !== '0';
export const WORKERS_PROMPT = [
  'For work that will take more than a few seconds (running a build or the tests, searching or editing many files, research),',
  'hand it to the `worker` agent with the Agent tool instead of doing it yourself, then answer the user straight away in one short sentence',
  'saying what you started, so they can keep talking to you. Run at most four workers at a time.',
  'When a worker finishes you will be told; then tell the user the result in one or two sentences.',
  'Quick questions and small edits you do yourself. Anything a worker needs from the user, you ask, not the worker.',
].join(' ');

// The user may be in a headset and hears a short spoken version of each reply
// (the VR client strips this tag from the text it shows). AGENT_SPOKEN=0 turns it off.
export const SPOKEN_PROMPT = process.env.AGENT_SPOKEN === '0' ? '' : [
  'The user is often working by voice and hears a short spoken version of your replies.',
  'At the very end of the final message of each turn, add one or two plain sentences wrapped as <spoken>...</spoken>:',
  'what you did or found, and any question you need answered. Write it as you would say it out loud:',
  'no code, file paths, URLs, symbols or markdown inside it, and do not mention the tag itself.',
].join(' ');

const log = (...a) => console.error(`[agent-service ${new Date().toISOString()}]`, ...a);

// This process holds people's work. A bug in one handler is logged, not fatal.
process.on('uncaughtException', (e) => log('uncaught exception', e?.stack || e));
process.on('unhandledRejection', (e) => log('unhandled rejection', e?.stack || e));

// ---- `agent-service busy` --------------------------------------------------------
async function askBusy() {
  return new Promise((resolve) => {
    const sock = net.connect(SOCKET);
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.on('error', () => done(false)); // no service, nothing running
    sock.setTimeout(3000, () => done(false));
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'busy_query' }) + '\n'));
    readline.createInterface({ input: sock }).on('error', () => done(false)).on('line', (l) => { try { done(Boolean(JSON.parse(l).busy)); } catch { done(false); } });
  });
}

if (process.argv[2] === 'busy') {
  process.exit((await askBusy()) ? 0 : 1);
}

// ---- the service ----------------------------------------------------------------
const sdk = await import(process.env.AGENT_SDK_MODULE || '@anthropic-ai/claude-agent-sdk');
const env = {
  home: HOME,
  autoAllow: (process.env.AGENT_AUTO_ALLOW || 'Read,Glob,Grep,TodoWrite').split(',').filter(Boolean),
  settingSources: (process.env.AGENT_SETTING_SOURCES ?? 'user,project,local').split(',').filter(Boolean),
  systemPromptAppend: [SPOKEN_PROMPT, WORKERS ? WORKERS_PROMPT : ''].filter(Boolean).join(' '),
  workers: WORKERS ? {
    description: 'Does a slow job in the background (builds, tests, bulk edits, research) and reports the result in one short sentence.',
    prompt: 'You are a background worker. Do exactly what you are asked, then reply with one short sentence saying what you did and the result.',
    background: true,
    model: process.env.AGENT_WORKER_MODEL || 'inherit',
  } : null,
  permissionMode: process.env.AGENT_PERMISSION_MODE || 'default',
};

// Sessions the user has closed. A session lives on in the SDK's transcripts on disk, which the list is built
// from, so closing has to be remembered here or it would come straight back as "asleep". Attaching to one on
// purpose brings it back. Kept in a file so it survives a restart.
const hidden = new Set((() => { try { const a = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8')); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } })());
function saveHidden() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(HIDDEN_FILE, JSON.stringify([...hidden]), { mode: 0o600 }); } catch (e) { log('could not save the closed-sessions list', e.message); }
}

const sessions = new Map(); // service id -> Session
const loginFlow = new LoginFlow();

const liveCount = () => [...sessions.values()].filter((s) => s.live).length;
const findBySdkId = (id) => [...sessions.values()].find((s) => s.sdkId === id && s.state !== 'closed') ?? null;

function makeSession({ cwd, resume, legacy = false }) {
  const s = new Session({
    sdk, env, cwd, resume, log,
    onEnd: (x) => { sessions.delete(x.id); },
    onState: (x, state) => { if (state === 'idle') maybeEndLegacy(x); },
  });
  s.legacy = legacy;
  sessions.set(s.id, s);
  return s;
}

// A session made by a page that never asked to attach ends with its page, once it is not busy.
function maybeEndLegacy(s) {
  if (s.legacy && s.viewers.size === 0 && !s.busy) s.close();
}

// A prompt needs a live SDK process. At the cap, shut down an idle one nobody is watching; failing that, say so.
function ensureRoom(s) {
  if (s.live || liveCount() < MAX_LIVE) return true;
  const spare = [...sessions.values()].filter((x) => x.live && !x.busy && x.viewers.size === 0).sort((a, b) => a.lastActivity - b.lastActivity)[0];
  if (spare) { spare.stop(); return true; }
  return false;
}

class Viewer {
  constructor(socket) {
    this.socket = socket;
    this.session = null;
  }

  send(obj) {
    if (!this.socket.destroyed) this.socket.write(JSON.stringify(obj) + '\n');
  }

  async attach({ session: id, sdkId, cwd }, legacy = false) {
    if (sdkId && hidden.delete(sdkId)) saveHidden(); // asking for it by name brings a closed session back
    let s = id ? sessions.get(id) : sdkId ? findBySdkId(sdkId) : null;
    if (id && !s) return this.send({ type: 'error', message: 'That session is no longer there.' });
    if (!s) s = makeSession({ cwd, resume: sdkId, legacy });
    if (s.state === 'closed') return this.send({ type: 'error', message: 'That session has ended.' });
    this.detach();
    this.session = s; // set before the await so messages sent right after attach find it
    await s.ready;
    if (this.session !== s) return; // moved on while the transcript loaded
    s.viewers.add(this);
    s.catchUp(this);
  }

  detach() {
    const s = this.session;
    this.session = null;
    if (!s) return;
    s.viewers.delete(this);
    maybeEndLegacy(s);
  }

  async handle(msg) {
    switch (msg.type) {
      case 'busy_query':
        this.send({ type: 'busy', busy: [...sessions.values()].some((s) => s.busy) });
        break;
      case 'attach': await this.attach(msg); break;
      case 'detach': this.detach(); break;
      case 'list_sessions': this.send({ type: 'sessions', list: await listSessions() }); break;
      case 'close_session': {
        // By the service's handle for a live or dormant session it holds, or by SDK id for one known only from its transcript.
        const held = typeof msg.session === 'string' ? sessions.get(msg.session) : null;
        const sdkId = held?.sdkId ?? (typeof msg.sdkId === 'string' ? msg.sdkId : null);
        if (!held && !sdkId) { this.send({ type: 'error', message: msg.session ? 'That session is no longer there.' : 'Which session? Name it by id.' }); break; }
        (held ?? findBySdkId(sdkId))?.close();
        if (sdkId) { hidden.add(sdkId); saveHidden(); }
        break;
      }
      case 'prompt': {
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        if (!this.session) await this.attach({ sdkId: msg.resume, cwd: msg.cwd }, true); // an old-style page
        const s = this.session;
        if (!s || !s.viewers.has(this)) return;
        if (!ensureRoom(s)) return this.send({ type: 'error', message: `${MAX_LIVE} sessions are already running. Close one first.` });
        s.prompt(msg.text, this);
        break;
      }
      case 'permission': this.session?.answer(msg.id, Boolean(msg.allow), Boolean(msg.always)); break;
      case 'interrupt': this.session?.interrupt(); break;
      case 'stop_task': if (typeof msg.task === 'string') this.session?.stopTask(msg.task); break;
      case 'login_start': loginFlow.start((m) => this.send(m)); break;
      case 'login_code': loginFlow.code(msg.code); break;
      case 'login_cancel': loginFlow.cancel(); break;
      default: log('ignoring unknown message type', msg.type);
    }
  }
}

// What the picker shows: the sessions this service knows, plus the SDK's list of past ones.
async function listSessions() {
  const known = [...sessions.values()];
  const rows = known.map((s) => ({
    session: s.id, sdkId: s.sdkId, cwd: s.cwd, summary: s.firstPrompt, lastModified: s.lastActivity,
    state: s.live || s.state !== 'idle' ? s.state : 'dormant', live: s.live, viewers: s.viewers.size, workers: s.running.length,
  }));
  try {
    for (const info of await sdk.listSessions({ limit: MAX_LIST })) {
      if (known.some((s) => s.sdkId === info.sessionId) || hidden.has(info.sessionId)) continue;
      rows.push({ session: null, sdkId: info.sessionId, cwd: info.cwd ?? '', summary: info.customTitle || info.firstPrompt || info.summary || '', lastModified: info.lastModified, state: 'dormant', live: false, viewers: 0 });
    }
  } catch (e) { log('could not list sessions', e.message); }
  return rows.sort((a, b) => b.lastModified - a.lastModified).slice(0, MAX_LIST);
}

function serve() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const server = net.createServer((socket) => {
    const viewer = new Viewer(socket);
    // readline re-emits the socket's errors, and an unhandled one (a client that vanished
    // mid-write, ECONNRESET) would take the whole service, and every session, down with it.
    const rl = readline.createInterface({ input: socket });
    rl.on('error', () => viewer.detach());
    // Handle one line at a time so an attach finishes before the prompt behind it.
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      chain = chain.then(async () => {
        try { await viewer.handle(JSON.parse(line)); } catch (e) { viewer.send({ type: 'error', message: `bad input: ${e.message}` }); }
      });
    });
    const gone = () => viewer.detach();
    socket.on('close', gone);
    socket.on('error', gone);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { log('another service already holds the socket'); process.exit(0); }
    log('server error', e.message);
    process.exit(1);
  });
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    fs.writeFileSync(PIDFILE, String(process.pid));
    log(`listening on ${SOCKET}`);
  });

  // Free memory held by idle sessions nobody is watching; they resume from their transcripts.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) if (s.live && !s.busy && s.viewers.size === 0 && now - s.lastActivity > IDLE_STOP_MS) { log('stopping idle session', s.id); s.stop(); }
  }, SWEEP_MS);
  sweep.unref();

  const shutdown = () => {
    for (const s of sessions.values()) s.stop();
    loginFlow.cancel();
    server.close();
    for (const f of [SOCKET, PIDFILE]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, shutdown);
}

// A leftover socket file from a service that died is removed; a live one means we are not needed.
const probe = net.connect(SOCKET);
probe.on('connect', () => { probe.destroy(); log('already running'); process.exit(0); });
probe.on('error', () => { try { fs.unlinkSync(SOCKET); } catch { /* none */ } serve(); });
