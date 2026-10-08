// Scene, XR session management and pointer interaction. Panels (./*-panel.js)
// own their content; this file only places them, points at them, and routes
// input. To add a new kind of thing to the world, make a Panel subclass and
// add() it below.
import * as THREE from 'three';
import { TerminalPanel } from './terminal-panel.js';
import { ConversationPanel } from './conversation-panel.js';
import { quickKeys, snippetPanel } from './button-panel.js';
import { KeyboardPanel } from './keyboard-panel.js';
import { VoicePanel } from './voice-panel.js';
import { Voice } from './voice.js';
import { Speaker } from './speech.js';
import { LAYOUT, terminalPlacement, documentPlacement } from './layout.js';
import { ToolGroup } from './tools.js';
import { WindowManager, TitleBar } from './windows.js';
import { MarkdownPanel } from './markdown-panel.js';
import { WindowFeed } from './window-feed.js';
import { LoginFlow, LoginDialog } from './login.js';
import { keyToSequence } from './keys.js';

const $ = (id) => document.getElementById(id);
const note = $('note');
const cfg = await fetch('config.json').then((r) => r.json());

// ---- scene ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0); // text sharpness matters more than peripheral savings
renderer.xr.setFramebufferScaleFactor(1.4);
document.body.prepend(renderer.domElement);

const BG = new THREE.Color(0x05070a);
const scene = new THREE.Scene();
scene.background = BG;
const grid = new THREE.GridHelper(12, 24, 0x1f2a38, 0x121921);
scene.add(grid);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 50);
camera.position.set(0, 1.45, 0.9); // flat-screen view only; XR drives its own camera
camera.lookAt(0, 1.3, -1.4);

// ---- panels --------------------------------------------------------------
// Every panel is a window: windows.js gives it a title bar (drag to move, home,
// close) and remembers where you put it.
const windows = new WindowManager({ scene });
const allPanels = () => windows.panels; // windows and their title bars: everything pointable
const terminals = [];
const focusables = []; // things that take typing/dictation: the conversation, then terminals
let focused = null;

function add(panel, placement, meta) {
  windows.add(panel, { ...meta, placement });
  return panel;
}

function focus(t) {
  focused = t;
  focusables.forEach((x) => x.setFocused(x === t));
}

// The conversation with Claude is the main view; terminals are the escape hatch
// (?terms=N for more than one). Both can be grabbed and moved.
const params = new URLSearchParams(location.search);
const termCount = Number(params.get('terms') ?? 1);

const voice = new Voice();
// Spoken replies. Stays quiet while the microphone is open, so it never talks over you.
const speaker = new Speaker({
  // The Quest's browser has no speech engine of its own, so the hub makes the audio.
  remote: cfg.ttsEnabled ? { url: 'api/tts' } : null,
  onChange: () => convo?.markDirty(),
  onError: (msg) => convo?.convo.notice(msg, 'error'),
});
speaker.hold = () => voice.recording;
// What this browser offers for speech, shown on the flat page so a silent headset can be diagnosed.
{
  const yn = (v) => (v ? 'yes' : 'no');
  const g = globalThis;
  document.getElementById('diag').textContent = `Speech: speechSynthesis ${yn(g.speechSynthesis)}, Utterance ${yn(g.SpeechSynthesisUtterance)}, AudioContext ${yn(g.AudioContext || g.webkitAudioContext)}, hub voice ${yn(cfg.ttsEnabled)}`;
}

let convo = null;
if (cfg.agentUrl && params.get('agent') !== '0') {
  convo = new ConversationPanel({ agentUrl: cfg.agentUrl, cwd: cfg.agentCwd, widthM: LAYOUT.conversation.widthM, speaker });
  convo.onActivate = focus;
  // An expired Claude login is fixed from the flat page: a link to click and a code to paste.
  const login = new LoginFlow({ send: (m) => convo.client.send(m), onSignedIn: () => convo.client.connect() });
  new LoginDialog(login);
  convo.onAuth = (m) => login.handle(m);
  $('sign-in').onclick = () => login.start();
  window.__vr_login = login;
  focusables.push(convo);
  add(convo, LAYOUT.conversation, { id: 'claude', title: 'Claude', closable: false });
}

for (let i = 1; i <= termCount; i++) {
  const t = new TerminalPanel({ name: `term ${i}`, ttydUrl: cfg.ttydUrl });
  t.onActivate = focus;
  terminals.push(t);
  focusables.push(t);
  add(t, terminalPlacement(i), { id: `term-${i}`, title: `Terminal ${i}` });
}
focus(focusables[0]);

const sendToFocused = (s) => focused?.send(s);

const voicePanel = new VoicePanel({ voice, getTarget: () => focused, sttEnabled: cfg.sttEnabled, speaker });
add(voicePanel, LAYOUT.voice, { id: 'voice', title: 'Voice', closable: false });

const keyboard = new KeyboardPanel({ onSend: sendToFocused });
add(keyboard, LAYOUT.keyboard, { id: 'keyboard', title: 'Keyboard' });

const keysPanel = add(quickKeys(sendToFocused, { onToggleKeyboard: () => { keyboard.mesh.visible = !keyboard.mesh.visible; } }),
  LAYOUT.keys, { id: 'keys', title: 'Keys' });

const snippets = await fetch('snippets.json').then((r) => r.json()).catch(() => []);
const snippetsPanel = snippets.length ? add(snippetPanel(snippets, sendToFocused), LAYOUT.snippets, { id: 'snippets', title: 'Snippets' }) : null;

// Everything except the conversation and the voice bar lives behind one toggle.
const tools = new ToolGroup([keyboard, keysPanel, ...(snippetsPanel ? [snippetsPanel] : []), ...terminals], {
  persist: Boolean(convo),
  onChange: (visible) => { if (!visible && convo && focused !== convo) focus(convo); },
});
voicePanel.toolGroup = tools;
const visibleFocusables = () => focusables.filter((f) => f.mesh.visible);

// Document windows Claude (or anything that can write windows.json) opens on request.
const docSlots = new Map(); // window id -> placement slot, so closed slots are reused
const docId = (id) => `doc-${id}`;
const feed = new WindowFeed({
  open: (e, text) => {
    let slot = 0;
    while ([...docSlots.values()].includes(slot)) slot++;
    docSlots.set(docId(e.id), slot);
    add(new MarkdownPanel({ text, name: e.id }), documentPlacement(slot), { id: docId(e.id), title: e.title });
  },
  update: (e, text) => {
    const win = windows.find(docId(e.id));
    if (!win) return;
    win.title = e.title;
    win.panel.set(text);
    win.bar.markDirty();
    win.open(); // new content brings back a window you closed
  },
  close: (id) => { windows.remove(docId(id)); docSlots.delete(docId(id)); },
});
feed.start();

window.__vr = { scene, camera, windows, feed, terminals, focusables, focus, voice, speaker, renderer, tools }; // for debugging from the console

// ---- pointers (two controllers + the mouse) --------------------------------
const raycaster = new THREE.Raycaster();
const tmpM = new THREE.Matrix4();
const meshes = () => allPanels().filter((p) => p.shown).map((p) => p.mesh);
const eye = new THREE.Vector3();
const eyePosition = () => (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).getWorldPosition(eye);

function castRay(ray) {
  raycaster.ray.copy(ray);
  const hit = raycaster.intersectObjects(meshes(), false)[0];
  return hit ? { panel: hit.object.userData.panel, uv: hit.uv, point: hit.point, distance: hit.distance } : null;
}

const rayLine = () => {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x4da3ff }));
};

const pointers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const line = rayLine();
  c.add(line);
  scene.add(c);
  const p = { c, line, source: null, hit: null, ray: null, drag: null, grabbed: null, prev: [] };
  c.addEventListener('connected', (e) => { p.source = e.data; });
  c.addEventListener('disconnected', () => { p.source = null; endDrag(p); });
  c.addEventListener('selectstart', () => press(p));
  c.addEventListener('selectend', () => endDrag(p));
  c.addEventListener('squeezestart', () => grab(p));
  c.addEventListener('squeezeend', () => release(p));
  return p;
});

const mouse = { ndc: new THREE.Vector2(), hit: null, active: false, drag: null };
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouse.active = true;
});
renderer.domElement.addEventListener('pointerleave', () => { mouse.active = false; endDrag(mouse); });
renderer.domElement.addEventListener('wheel', (e) => { mouse.hit?.panel.onScroll?.(-e.deltaY / 60); }, { passive: true });
renderer.domElement.addEventListener('pointerdown', () => {
  if (!mouse.hit) return;
  if (!startDrag(mouse, mouse.hit, raycaster.ray)) mouse.hit.panel.click(mouse.hit.uv);
});
addEventListener('pointerup', () => endDrag(mouse));

function buzz(p) {
  try { p.source?.gamepad?.hapticActuators?.[0]?.pulse(0.35, 25); } catch { /* optional */ }
}

// Pressing the body of a title bar picks the window up; anything else is a click.
function startDrag(slot, hit, ray) {
  if (!(hit.panel instanceof TitleBar) || !hit.panel.isDragPoint(hit.uv)) return false;
  slot.drag = windows.beginDrag(hit.panel, ray.clone(), hit.point);
  return true;
}

function endDrag(slot) {
  if (!slot.drag) return;
  windows.save(slot.drag.win);
  slot.drag = null;
}

function press(p) {
  if (!p.hit) return;
  if (!startDrag(p, p.hit, p.ray)) p.hit.panel.click(p.hit.uv);
  buzz(p);
}

// Keeps a dragged window under the pointer; runs every frame.
function updateDrags() {
  for (const p of pointers) if (p.drag && p.ray) p.drag.update(p.ray, eyePosition());
  if (mouse.drag) {
    raycaster.setFromCamera(mouse.ndc, camera);
    mouse.drag.update(raycaster.ray, camera.position);
  }
}

// Grabbing a title bar grabs its window.
function grab(p) {
  if (!p.hit || p.grabbed || p.drag) return;
  p.grabbed = p.hit.panel.owner ?? p.hit.panel;
  p.c.attach(p.grabbed.mesh); // keeps its world transform, now follows the hand
  buzz(p);
}

function release(p) {
  if (!p.grabbed) return;
  scene.attach(p.grabbed.mesh);
  const win = windows.byPanel(p.grabbed);
  if (win) windows.save(win);
  p.grabbed = null;
}

// Button mapping (Quest Touch): right A = push-to-talk, right B = Enter,
// left X = next terminal. Thumbstick Y while holding a panel resizes it.
function pollButtons(dt) {
  for (const p of pointers) {
    const gp = p.source?.gamepad;
    if (!gp) continue;
    const down = (i) => Boolean(gp.buttons[i]?.pressed);
    const edge = (i) => down(i) !== Boolean(p.prev[i]) ? down(i) : null; // true=pressed, false=released
    const hand = p.source.handedness;
    const a = edge(4);
    if (hand === 'right') {
      if (a === true) voicePanel.pttDown();
      if (a === false) voicePanel.pttUp();
      if (edge(5) === true) focused?.send('\r');
    } else if (hand === 'left' && edge(5) === true) {
      tools.toggle();
    } else if (hand === 'left' && edge(3) === true) {
      windows.resetAll(); // left thumbstick press: every window back where it started
    } else if (hand === 'left' && a === true) {
      const list = visibleFocusables();
      focus(list[(list.indexOf(focused) + 1) % list.length]);
    }
    p.prev = gp.buttons.map((b) => b.pressed);
    const stick = gp.axes[3] ?? 0;
    const held = p.grabbed ?? p.drag?.win.panel; // gripped or being dragged by its title bar
    if (!held && p.hit?.panel.onScroll && Math.abs(stick) > 0.2) p.hit.panel.onScroll(-stick * dt * 20);
    if (held) {
      const y = gp.axes[3] ?? 0;
      if (Math.abs(y) > 0.2) {
        const s = THREE.MathUtils.clamp(held.mesh.scale.x * (1 - y * dt * 0.8), 0.4, 3);
        held.mesh.scale.setScalar(s);
      }
    }
  }
}

function updateHover() {
  const hovered = new Map();
  const consider = (hit) => { if (hit && !hovered.has(hit.panel)) hovered.set(hit.panel, hit.uv); };

  for (const p of pointers) {
    if (!p.source) { p.line.visible = false; p.hit = null; continue; }
    p.line.visible = true;
    tmpM.identity().extractRotation(p.c.matrixWorld);
    const ray = new THREE.Ray(
      new THREE.Vector3().setFromMatrixPosition(p.c.matrixWorld),
      new THREE.Vector3(0, 0, -1).applyMatrix4(tmpM),
    );
    p.ray = ray;
    p.hit = castRay(ray);
    p.line.scale.z = p.hit ? p.hit.distance : 3;
    consider(p.hit);
  }

  if (!renderer.xr.isPresenting && mouse.active) {
    raycaster.setFromCamera(mouse.ndc, camera);
    mouse.hit = castRay(raycaster.ray);
    consider(mouse.hit);
  } else mouse.hit = null;

  for (const panel of allPanels()) panel.setHover(hovered.get(panel) ?? null);
}

// ---- keyboard (flat screen and Bluetooth keyboards in VR) ------------------
addEventListener('keydown', (e) => {
  if (e.key === 'F2') { e.preventDefault(); tools.toggle(); return; }
  if (e.key === 'F3') { e.preventDefault(); windows.resetAll(); return; }
  if (!focused) return;
  const seq = keyToSequence(e);
  if (seq === null) return;
  e.preventDefault();
  focused.send(seq);
});
addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text');
  if (text && focused) { e.preventDefault(); focused.paste(text); }
});

// ---- session / UI ----------------------------------------------------------
renderer.xr.addEventListener('sessionstart', () => {
  const opaque = renderer.xr.getSession().environmentBlendMode === 'opaque';
  scene.background = opaque ? BG : null;
  grid.visible = opaque;
});
renderer.xr.addEventListener('sessionend', () => { scene.background = BG; grid.visible = true; });

async function enter(mode) {
  const session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor'] });
  await renderer.xr.setSession(session);
}

async function setupButtons() {
  if (!navigator.xr) { note.textContent = 'WebXR is not available in this browser. Flat view only.'; return; }
  for (const [id, mode] of [['enter-vr', 'immersive-vr'], ['enter-mr', 'immersive-ar']]) {
    const ok = await navigator.xr.isSessionSupported(mode).catch(() => false);
    const btn = $(id);
    btn.disabled = !ok;
    btn.onclick = () => { speaker.unlock(); enter(mode).catch((e) => { note.textContent = `Could not start: ${e.message}`; }); };
  }
}

// Mic permission prompts don't work inside an immersive session, so ask here,
// in the flat page, before entering.
async function setupMic() {
  const btn = $('enable-mic');
  const tryInit = async () => {
    speaker.unlock();
    try { await voice.init(); btn.hidden = true; } catch (e) { note.textContent = `Microphone: ${e.message}`; }
  };
  const perm = await navigator.permissions?.query({ name: 'microphone' }).catch(() => null);
  if (perm?.state === 'granted') await tryInit();
  else { btn.hidden = false; btn.onclick = tryInit; }
}

fetch('api/whoami').then((r) => r.json()).then((w) => { note.textContent = `Signed in as ${w.user}. Drag a title bar (or grip a panel) to move it, thumbstick while moving resizes, thumbstick = scroll, A = talk (tap or hold), B = send, X = switch panel, Y = tools, left stick press = reset windows.`; })
  .catch(() => { note.textContent = 'Not signed in?'; });
setupButtons();
setupMic();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  pollButtons(dt);
  updateHover();
  updateDrags();
  for (const p of allPanels()) if (p.shown) p.update(); // hidden panels redraw when shown
  renderer.render(scene, camera);
});
