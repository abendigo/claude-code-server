// The flat web app: the same Claude sessions as the VR page, in an ordinary web
// page (laptop or phone). It shares the connection, the conversation model, the
// session list, the Activity logic and the markdown parser with the VR page, and
// only draws them differently. It never speaks: speech is for VR.
import { Conversation } from '../conversation.js';
import { AgentClient } from '../agent-client.js';
import { sessionStore } from '../session-store.js';
import { LoginFlow, LoginDialog } from '../login.js';
import { WindowFeed } from '../window-feed.js';
import { Voice } from '../voice.js';
import { approvalIntent, cleanTranscript } from '../transcript.js';
import { renderLog, renderApproval, renderSessions, renderActivity, renderDocs, stateLabel } from './views.js';
import { sendPrompt, answerApproval, stopWork } from './actions.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const showTools = params.get('tools') === '1';
const cfg = await fetch('config.json').then((r) => r.json());

// ---- model and connection -------------------------------------------------------------
let render = () => {};
let login = null;
const convo = new Conversation({
  onChange: () => render(),
  onSpeak: () => {}, // the flat app never speaks
  onAuth: (m) => login?.handle(m),
});
const client = new AgentClient(cfg.agentUrl, convo, { cwd: cfg.agentCwd, store: sessionStore });
login = new LoginFlow({ send: (m) => client.send(m), onSignedIn: () => client.connect() });
new LoginDialog(login);

// ---- state of the page itself ---------------------------------------------------------
const docs = new Map(); // id -> {title, text}
let selectedDoc = null;
let armed = null; // session whose End was tapped once
let armedTimer = null;
let armedTask = null; // worker whose Stop was tapped once
let armedTaskTimer = null;
let wasWorking = false;

const log = $('log');
const stick = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

function draw() {
  const now = Date.now();
  const atBottom = stick();
  renderLog(log, convo, { showTools });
  if (atBottom) log.scrollTop = log.scrollHeight;
  renderApproval($('approval'), convo, { onAnswer: (k) => answerApproval(convo, client, k) });
  renderSessions($('sessions'), convo, now, {
    armed,
    onNew: () => { client.newSession(); refreshSoon(); },
    onSwitch: (r) => { client.switchTo(r); refreshSoon(); },
    onEnd: (r) => {
      if (armed === r.session) { armed = null; client.closeSession(r.session); refreshSoon(); } else {
        armed = r.session;
        clearTimeout(armedTimer);
        armedTimer = setTimeout(() => { armed = null; render(); }, 3000);
      }
      render();
    },
  });
  renderActivity($('activity'), convo, now, {
    armedTask,
    onStopTask: (id) => {
      if (armedTask === id) { armedTask = null; client.stopTask(id); } else {
        armedTask = id;
        clearTimeout(armedTaskTimer);
        armedTaskTimer = setTimeout(() => { armedTask = null; render(); }, 3000);
      }
      render();
    },
  });
  renderDocs($('docs'), docs, selectedDoc, { onSelect: (id) => { selectedDoc = id; render(); } });

  const label = stateLabel(convo);
  $('state').textContent = label;
  $('state').className = `state ${convo.state}`;
  $('stop').hidden = !(convo.state === 'working' || convo.state === 'waiting');
  $('send').disabled = convo.state === 'offline';
  // A background tab can't be glanced at, so say in its title when Claude needs you or has finished.
  const needs = convo.state === 'waiting';
  const done = wasWorking && convo.state === 'idle';
  if (convo.state === 'working') wasWorking = true;
  else if (convo.state !== 'waiting') { if (done && document.hidden) document.title = 'Done · Claude'; wasWorking = false; }
  if (needs) document.title = 'Needs you · Claude';
  else if (!done && !document.hidden) document.title = 'Claude';
}

// Redraw at most once per frame, however fast messages arrive.
let queued = false;
render = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; draw(); });
};

// While Claude works the timers tick; otherwise there is nothing to animate.
setInterval(() => { if (convo.state === 'working' || convo.state === 'waiting' || convo.tasks.some((t) => t.status === 'running')) render(); }, 1000);
// Ages in the Sessions list, and the list itself.
const refreshSoon = () => setTimeout(() => client.listSessions(), 300);
setInterval(() => { if (client.open) client.listSessions(); }, 5000);
setInterval(render, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'Claude'; render(); } });

// ---- composer -------------------------------------------------------------------------
const input = $('input');
function submit(text = input.value) {
  if (sendPrompt(convo, client, text, { cwd: cfg.agentCwd, resumeId: sessionStore.read().sdk })) { if (text === input.value) input.value = ''; autosize(); }
}
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  else if (e.key === 'Escape') { input.value = ''; autosize(); }
});
$('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
$('stop').addEventListener('click', () => stopWork(client));

// ---- microphone (speech to text through the hub; the reply is never spoken) --------------
const voice = new Voice();
const mic = $('mic');
mic.hidden = !cfg.sttEnabled;
let listening = false;
async function toggleMic() {
  try {
    if (!voice.ready) await voice.init(); // asks for the microphone on the first click
    if (!listening) {
      listening = true;
      mic.classList.add('on');
      voice.start(() => stopMic()); // stops by itself after you stop talking
    } else await stopMic();
  } catch (e) {
    listening = false;
    mic.classList.remove('on');
    convo.notice(`Microphone: ${e.message}`, 'error');
  }
}
async function stopMic() {
  if (!listening) return;
  listening = false;
  mic.classList.remove('on');
  try {
    const { text } = await voice.transcribe(await voice.stop());
    if (!text.trim()) return;
    // While Claude waits for an approval, "yes" and "no" answer it; otherwise it is a message.
    const intent = convo.state === 'waiting' ? approvalIntent(text) : null;
    if (intent) answerApproval(convo, client, intent);
    else submit(cleanTranscript(text, 'prompt'));
  } catch (e) {
    convo.notice(`Speech: ${e.message}`, 'error');
  }
}
mic.addEventListener('click', toggleMic);

// ---- documents Claude opens (windows.json, as in VR) -------------------------------------
new WindowFeed({
  open: (e, text) => { docs.set(e.id, { title: e.title, text }); selectedDoc ??= e.id; render(); },
  update: (e, text) => { docs.set(e.id, { title: e.title, text }); selectedDoc = e.id; render(); },
  close: (id) => { docs.delete(id); if (selectedDoc === id) selectedDoc = null; render(); },
}).start();

// ---- narrow screens: one pane at a time ---------------------------------------------------
const tabs = [...$('tabs').children]; // the <button data-pane=…> in the nav
function showPane(name) {
  document.body.dataset.pane = name;
  tabs.forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
}
tabs.forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));
showPane('chat');

$('sign-in').addEventListener('click', () => login.start());
window.__app = { convo, client, docs, draw, submit }; // for debugging from the console
client.connect();
draw();
