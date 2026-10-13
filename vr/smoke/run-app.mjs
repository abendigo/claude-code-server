// Runs the real flat web app (client/js/app/app.js) in Node against a fake DOM, a fake
// websocket and a fake session service, and checks the wiring end to end.
import { installDom, El, all, byClass, button } from '../test/fake-dom.mjs';
const here = new URL('.', import.meta.url).pathname;

const { els } = installDom({ log: 'div', approval: 'div', sessions: 'aside', activity: 'section', docs: 'section', input: 'textarea', composer: 'form', stop: 'button', send: 'button', mic: 'button', state: 'span', 'sign-in': 'button', tabs: 'nav' });
for (const pane of ['chat', 'sessions', 'side']) { const b = new El('button'); b.dataset.pane = pane; els.tabs.appendChild(b); }
globalThis.window = globalThis;
globalThis.location = { href: 'https://h/vr/app.html', search: process.env.QUERY ?? '' };
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.fetch = async (u) => {
  if (u === 'windows.json') return { ok: true, status: 200, json: async () => ({ windows: [{ id: 'note', title: 'Note', markdown: '# Hello\n\n- one' }] }) };
  return { json: async () => (u === 'config.json' ? { ttydUrl: '/ws', agentUrl: '/agent/ws', agentCwd: '/workspace', sttEnabled: false, ttsEnabled: false } : []) };
};
const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = String(url); this.sent = []; this.readyState = 1; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  emit(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

const errors = [];
setTimeout(() => { console.log('FAIL  timed out'); process.exit(1); }, 25_000).unref(); // never hang the caller
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e?.stack || e)));
process.on('uncaughtException', (e) => errors.push('uncaught: ' + (e?.stack || e)));
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) errors.push('failed: ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import(here + '.build/client/js/app/app.js');
await sleep(80);
const ws = () => sockets.at(-1);

ok('the page connects and asks which sessions exist', ws().sent.some((m) => m.type === 'list_sessions'));
ok('the mic button is hidden without the speech service', els.mic.hidden === true);
ws().emit({ type: 'sessions', list: [{ session: 'svc1', sdkId: 'sdk1', cwd: '/workspace', summary: 'Fix the keyboard', state: 'idle', lastModified: Date.now() - 60000 }, { session: 'svc2', sdkId: 'sdk2', cwd: '/workspace', summary: 'Plan the service', state: 'working', lastModified: Date.now() }] });
ok('it attaches to the newest', ws().sent.some((m) => m.type === 'attach' && m.session === 'svc1'));
ws().emit({ type: 'attached', session: 'svc1', sdkId: 'sdk1', cwd: '/workspace', state: 'idle', live: true });
ws().emit({ type: 'history', messages: [
  { type: 'user_prompt', text: 'run the tests', at: 1000 },
  { type: 'sdk', at: 2000, message: { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } } },
  { type: 'sdk', at: 5000, message: { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } },
  { type: 'sdk', at: 6000, message: { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'All green.\n\n- one\n- two\n\n<spoken>The tests pass.</spoken>' }] } } },
] });
await sleep(30);
ok('history fills the conversation', byClass(els.log, 'msg').length === 2 && els.log.textContent.includes('All green.'));
ok('the spoken summary is not shown', !els.log.textContent.includes('The tests pass'));
ok('tool calls are in the Activity pane, not the log', els.activity.textContent.includes('Run the tests') && !els.log.textContent.includes('Run the tests'));
ok('the session is listed and marked as the current one', byClass(els.sessions, 'current').length === 1 && els.sessions.textContent.includes('Fix the keyboard'));
ok('the status shows ready', els.state.textContent === 'ready');
await sleep(300);
ok('documents from windows.json appear', els.docs.hidden === false && els.docs.textContent.includes('Hello'));

// Typing and pressing Enter sends a prompt.
els.input.value = 'please continue';
els.input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {} });
await sleep(30);
ok('Enter sends the prompt and clears the box', ws().sent.some((m) => m.type === 'prompt' && m.text === 'please continue' && m.resume === undefined) && els.input.value === '');
ok('the page shows it as working, with Stop available', els.state.textContent === 'working' && els.stop.hidden === false);
els.input.value = 'line one';
els.input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true, isComposing: false, preventDefault() {} });
ok('Shift+Enter does not send', !ws().sent.some((m) => m.text === 'line one'));

// An approval appears above the composer and Allow answers it.
ws().emit({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'rm -rf build' }, displayName: 'Bash' });
await sleep(30);
ok('the approval bar shows and the tab title asks for you', els.approval.hidden === false && globalThis.document.title === 'Needs you · Claude');
button(els.approval, 'Allow').click();
ok('Allow sends the answer', ws().sent.some((m) => m.type === 'permission' && m.id === 'p1' && m.allow === true));

// Switching sessions from the list.
const other = byClass(els.sessions, 'pick').find((b) => b.textContent.includes('Plan the service'));
other.click();
ok('picking another session attaches to it', ws().sent.at(-1).type === 'attach' && ws().sent.at(-1).session === 'svc2');

// A background worker runs: the session is free, the pane lists it, and Stop takes two taps.
ws().emit({ type: 'tasks', session: 'svc1', tasks: [{ id: 'w1', description: 'Run the long build', status: 'running', startedAt: Date.now() - 5000, endedAt: null, last: 'Bash', summary: '' }] });
await sleep(30);
ok('a running worker is listed in the Activity pane', els.activity.textContent.includes('Run the long build') && els.activity.textContent.includes('using Bash'));
button(els.activity, 'Stop').click();
await sleep(30); // the redraw happens on the next frame
ok('the first tap on Stop only arms it', !ws().sent.some((m) => m.type === 'stop_task') && button(els.activity, 'Stop?') !== undefined);
button(els.activity, 'Stop?').click();
ok('the second tap stops the worker', ws().sent.some((m) => m.type === 'stop_task' && m.task === 'w1'));

// The connection drops and returns.
const before = sockets.length;
ws().drop();
await sleep(30);
ok('a dropped connection shows as reconnecting', els.state.textContent === 'Reconnecting…');
await sleep(1200);
ok('it reconnects by itself', sockets.length === before + 1);

ok('no errors', errors.filter((e) => !e.startsWith('failed:')).length === 0, JSON.stringify(errors.slice(0, 3)));
process.exit(errors.length ? 1 : 0);
