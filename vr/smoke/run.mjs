import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const THREE = await import('three');
const here = new URL('.', import.meta.url).pathname;

const ctx2d = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : () => {}), set: () => true });
const listeners = {}; const domListeners = {}; const els = {};
const on = (obj) => (type, fn) => { (obj[type] ||= []).push(fn); };
const fire = (obj, type, ev = {}) => (obj[type] || []).forEach((f) => f(ev));
const el = (id) => (els[id] ||= { id, textContent: '', hidden: false, disabled: false, style: {}, addEventListener() {}, onclick: null });
const anyEl = () => new Proxy(function () {}, { get: (_t, k) => (k === 'getContext' ? () => ctx2d : anyEl()), set: () => true, apply: () => anyEl() });
globalThis.window = globalThis;
globalThis.innerWidth = 1280; globalThis.innerHeight = 800; globalThis.devicePixelRatio = 1;
globalThis.location = { href: 'https://h/vr/', search: process.env.QUERY ?? '' };
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { permissions: { query: async () => ({ state: 'denied' }) } }, configurable: true });
globalThis.addEventListener = on(listeners);
globalThis.document = { body: anyEl(), head: anyEl(), getElementById: el, querySelector: () => anyEl(),
  createElement: (tag) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => ctx2d, addEventListener() {} } : anyEl()) };
globalThis.fetch = async (u) => {
  if (u === 'windows.json') return { ok: true, status: 200, json: async () => ({ windows: [{ id: 'note', title: 'Note', markdown: '# Hello\n\n- one\n- two' }] }) };
  return { json: async () => (u === 'config.json' ? { ttydUrl: '/ws', agentUrl: '/agent/ws', agentCwd: '/workspace', sttEnabled: false, ttsEnabled: false } : u === 'api/whoami' ? { user: 'tester' } : []) };
};
const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = String(url); this.sent = []; this.readyState = 1; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(d) { try { this.sent.push(JSON.parse(d)); } catch { this.sent.push({ type: 'raw' }); } } // the terminal's socket sends non-JSON
  close() { this.readyState = 3; }
  emit(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

let loop = null;
globalThis.__FakeRenderer = class {
  constructor() {
    this.domElement = { addEventListener: on(domListeners) };
    this.xr = { enabled: false, isPresenting: false, setReferenceSpaceType() {}, setFoveation() {}, setFramebufferScaleFactor() {}, addEventListener() {}, getController: () => new THREE.Group(), getCamera: () => new THREE.PerspectiveCamera() };
  }
  setPixelRatio() {} setSize() {}
  setAnimationLoop(fn) { loop = fn; }
  render(scene, camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); }
};

const errors = [];
setTimeout(() => { console.log('FAIL  timed out'); process.exit(1); }, 25_000).unref(); // never hang the caller
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e?.stack || e)));
await import(here + '.build/client/js/main.js');
await new Promise((r) => setTimeout(r, 60));
let t = 0;
const frame = (n = 1) => { for (let i = 0; i < n; i++) { t += 16; loop(t); } };
frame(3);

const v = window.__vr;
const win = (id) => v.windows.find(id);
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) errors.push('failed: ' + name); };
const pos = (id) => win(id).panel.mesh.position.toArray().map((n) => +n.toFixed(2));
const claude = win('claude');
const agentSockets = () => sockets.filter((s) => s.url.includes('/agent/'));
const ws = () => agentSockets().at(-1);

ok('windows built', ['claude', 'activity', 'sessions', 'voice', 'keyboard', 'keys', 'term-1', 'doc-note'].every((id) => win(id)), v.windows.windows.map((w) => w.id).join(','));
ok('activity is right of the conversation, documents left', pos('activity')[0] > 1 && pos('doc-note')[0] < -1);
ok('main view hides tool cards by default', claude.panel.showTools === false);
ok('Sessions window starts closed', win('sessions').panel.mesh.visible === false);
ok('speech is held while not in an immersive VR session', v.speaker.hold() === true);

// The page asks the service for its newest session (nothing is remembered yet).
ok('on connect the page asks which sessions exist', ws().sent.some((m) => m.type === 'list_sessions'), JSON.stringify(ws().sent.map((m) => m.type)));
ws().emit({ type: 'sessions', list: [{ session: 'svc1', sdkId: 'sdk1', cwd: '/workspace', summary: 'Fix the keyboard', state: 'idle', lastModified: Date.now() - 60000 }] });
ok('it attaches to the newest', ws().sent.some((m) => m.type === 'attach' && m.session === 'svc1'));
ws().emit({ type: 'attached', session: 'svc1', sdkId: 'sdk1', cwd: '/workspace', state: 'idle', live: true });
ws().emit({ type: 'history', messages: [
  { type: 'user_prompt', text: 'run the tests', at: 1000 },
  { type: 'sdk', at: 2000, message: { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } } },
  { type: 'sdk', at: 5000, message: { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } },
  { type: 'sdk', at: 6000, message: { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'All green.\n\n<spoken>The tests pass.</spoken>' }] } } },
] });
frame(2);
const cm = claude.panel.convo;
ok('history refills the conversation', cm.blocks.map((b) => b.kind).join() === 'user,tool,assistant', cm.blocks.map((b) => b.kind).join());
ok('and the session is remembered for the next reload', store['vr.agent.svc'] === 'svc1');

// Sessions window: opened from the Claude header, lists what the service sent.
claude.panel.onToggleSessions();
frame(2);
ok('the Sessions window opens', win('sessions').panel.mesh.visible === true && store['vr.sessions.open'] === '1');
ws().emit({ type: 'sessions', list: [{ session: 'svc1', sdkId: 'sdk1', cwd: '/workspace', summary: 'Fix the keyboard', state: 'idle', lastModified: Date.now() - 60000 }, { session: 'svc2', sdkId: 'sdk2', cwd: '/workspace', summary: 'Plan the service', state: 'working', lastModified: Date.now() }] });
frame(2);
ok('and shows them', win('sessions').panel.rows().length === 2);

// The connection drops and comes back by itself, to the same session.
const before = agentSockets().length;
ws().drop();
ok('a dropped connection shows as reconnecting', cm.state === 'connecting' && cm.status === 'Reconnecting…');
await new Promise((r) => setTimeout(r, 1200));
frame(2);
ok('it reconnects and attaches to the same session', agentSockets().length === before + 1 && ws().sent.some((m) => m.type === 'attach' && m.session === 'svc1'));

// Mouse drag of the Claude window by its title bar, then F3 reset.
const home = pos('claude');
const p = claude.bar.mesh.getWorldPosition(new THREE.Vector3()).project(v.camera);
const sx = (p.x + 1) / 2 * innerWidth - 200; const sy = (1 - p.y) / 2 * innerHeight;
fire(domListeners, 'pointermove', { clientX: sx, clientY: sy }); frame(2);
fire(domListeners, 'pointerdown'); frame(1);
fire(domListeners, 'pointermove', { clientX: sx + 200, clientY: sy + 80 }); frame(2);
fire(listeners, 'pointerup'); frame(1);
ok('title-bar drag moves and saves the window', Math.abs(pos('claude')[0] - home[0]) > 0.01 && Boolean(store['vr.win.claude']), `${home} -> ${pos('claude')}`);
fire(listeners, 'keydown', { key: 'F3', preventDefault() {} }); frame(1);
ok('F3 resets', JSON.stringify(pos('claude')) === JSON.stringify(home) && !store['vr.win.claude']);

// A working turn shows in the Activity window, not in the main view.
const act = win('activity');
cm.submit('please run the tests');
cm.handle({ type: 'sdk', message: { type: 'assistant', parent_tool_use_id: null, message: { id: 'm9', content: [{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'npm test', description: 'Run the tests again' } }] } } });
frame(2);
const d0 = act.panel.lastDraw;
await new Promise((r) => setTimeout(r, 260)); frame(2);
ok('activity redraws by itself while working', act.panel.lastDraw > d0);
ok('tool calls are not in the main view', !claude.panel.buildLines(ctx2d, 1000).some((l) => l.text?.includes('Run the tests again')));

ok('no page errors', errors.filter((e) => !e.startsWith('failed:')).length === 0, JSON.stringify(errors.slice(0, 3)));
process.exit(errors.length ? 1 : 0);
