// Scene, XR session management and pointer interaction. Panels (./*-panel.js)
// own their content; this file only places them, points at them, and routes
// input. To add a new kind of thing to the world, make a Panel subclass and
// add() it below.
import * as THREE from 'three';
import { TerminalPanel } from './terminal-panel.js';
import { quickKeys } from './button-panel.js';
import { VoicePanel } from './voice-panel.js';
import { Voice } from './voice.js';
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
const panels = [];
const terminals = [];
let focused = null;

function add(panel, { pos, rotY = 0, rotX = 0 }) {
  panel.mesh.position.set(...pos);
  panel.mesh.rotation.set(rotX, rotY, 0, 'YXZ');
  scene.add(panel.mesh);
  panels.push(panel);
  return panel;
}

function focus(t) {
  focused = t;
  terminals.forEach((x) => x.setFocused(x === t));
}

for (const [i, x, rotY] of [[1, -0.8, 0.3], [2, 0.8, -0.3]]) {
  const t = new TerminalPanel({ name: `term ${i}`, ttydUrl: cfg.ttydUrl });
  t.onActivate = focus;
  terminals.push(t);
  add(t, { pos: [x, 1.6, -1.3], rotY });
}
focus(terminals[0]);

const sendToFocused = (s) => focused?.send(s);
add(quickKeys(sendToFocused), { pos: [0, 0.95, -0.95], rotX: -0.55 });

const voice = new Voice();
const voicePanel = new VoicePanel({ voice, getTarget: () => focused, sttEnabled: cfg.sttEnabled });
add(voicePanel, { pos: [0, 0.55, -0.8], rotX: -0.9 });

window.__vr = { scene, panels, terminals, focus, voice, renderer }; // for debugging from the console

// ---- pointers (two controllers + the mouse) --------------------------------
const raycaster = new THREE.Raycaster();
const tmpM = new THREE.Matrix4();
const meshes = () => panels.map((p) => p.mesh);

function castRay(ray) {
  raycaster.ray.copy(ray);
  const hit = raycaster.intersectObjects(meshes(), false)[0];
  return hit ? { panel: hit.object.userData.panel, uv: hit.uv, distance: hit.distance } : null;
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
  const p = { c, line, source: null, hit: null, grabbed: null, prev: [] };
  c.addEventListener('connected', (e) => { p.source = e.data; });
  c.addEventListener('disconnected', () => { p.source = null; });
  c.addEventListener('selectstart', () => press(p));
  c.addEventListener('squeezestart', () => grab(p));
  c.addEventListener('squeezeend', () => release(p));
  return p;
});

const mouse = { ndc: new THREE.Vector2(), hit: null, active: false };
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouse.active = true;
});
renderer.domElement.addEventListener('pointerleave', () => { mouse.active = false; });
renderer.domElement.addEventListener('pointerdown', () => { if (mouse.hit) mouse.hit.panel.click(mouse.hit.uv); });

function buzz(p) {
  try { p.source?.gamepad?.hapticActuators?.[0]?.pulse(0.35, 25); } catch { /* optional */ }
}

function press(p) {
  if (!p.hit) return;
  p.hit.panel.click(p.hit.uv);
  buzz(p);
}

function grab(p) {
  if (!p.hit || p.grabbed) return;
  p.grabbed = p.hit.panel;
  p.c.attach(p.grabbed.mesh); // keeps its world transform, now follows the hand
  buzz(p);
}

function release(p) {
  if (!p.grabbed) return;
  scene.attach(p.grabbed.mesh);
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
      if (a === true) voicePanel.startRecording();
      if (a === false) voicePanel.stopRecording();
      if (edge(5) === true) focused?.send('\r');
    } else if (hand === 'left' && a === true) {
      focus(terminals[(terminals.indexOf(focused) + 1) % terminals.length]);
    }
    p.prev = gp.buttons.map((b) => b.pressed);
    if (p.grabbed) {
      const y = gp.axes[3] ?? 0;
      if (Math.abs(y) > 0.2) {
        const s = THREE.MathUtils.clamp(p.grabbed.mesh.scale.x * (1 - y * dt * 0.8), 0.4, 3);
        p.grabbed.mesh.scale.setScalar(s);
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
    p.hit = castRay(ray);
    p.line.scale.z = p.hit ? p.hit.distance : 3;
    consider(p.hit);
  }

  if (!renderer.xr.isPresenting && mouse.active) {
    raycaster.setFromCamera(mouse.ndc, camera);
    mouse.hit = castRay(raycaster.ray);
    consider(mouse.hit);
  } else mouse.hit = null;

  for (const panel of panels) panel.setHover(hovered.get(panel) ?? null);
}

// ---- keyboard (flat screen and Bluetooth keyboards in VR) ------------------
addEventListener('keydown', (e) => {
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
    btn.onclick = () => enter(mode).catch((e) => { note.textContent = `Could not start: ${e.message}`; });
  }
}

// Mic permission prompts don't work inside an immersive session, so ask here,
// in the flat page, before entering.
async function setupMic() {
  const btn = $('enable-mic');
  const tryInit = async () => {
    try { await voice.init(); btn.hidden = true; } catch (e) { note.textContent = `Microphone: ${e.message}`; }
  };
  const perm = await navigator.permissions?.query({ name: 'microphone' }).catch(() => null);
  if (perm?.state === 'granted') await tryInit();
  else { btn.hidden = false; btn.onclick = tryInit; }
}

fetch('api/whoami').then((r) => r.json()).then((w) => { note.textContent = `Signed in as ${w.user}. Grip = move panel (thumbstick resizes), A = talk, B = Enter, X = switch terminal.`; })
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
  for (const p of panels) p.update();
  renderer.render(scene, camera);
});
