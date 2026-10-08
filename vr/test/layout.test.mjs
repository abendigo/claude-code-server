// No clickable control may be hidden behind another panel. For every control
// on every panel, cast a ray from several plausible eye positions (seated to
// standing, a little off-centre) and require that the control's own panel is
// the first thing hit. This is what a laser pointer or your eyes would see.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// ---- browser stubs ---------------------------------------------------------------
const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
globalThis.location = { href: 'https://host.example/vr/' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
class FakeWS {
  static OPEN = 1;
  static last = null;
  constructor() { this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send() {} close() {}
  emit(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
globalThis.WebSocket = FakeWS;

const { LAYOUT, terminalPlacement } = await import('../client/js/layout.js');
const { ConversationPanel } = await import('../client/js/conversation-panel.js');
const { VoicePanel } = await import('../client/js/voice-panel.js');
const { KeyboardPanel } = await import('../client/js/keyboard-panel.js');
const { Panel } = await import('../client/js/panel.js');
const { quickKeys, snippetPanel } = await import('../client/js/button-panel.js');
const { init, permissionRequest } = await import('./fixtures.mjs');
await new Promise((r) => setTimeout(r, 5));

// ---- build the scene exactly as main.js does ----------------------------------------
// Every panel is a window with a title bar above it, and the bars are obstacles too.
const { WindowManager } = await import('../client/js/windows.js');
const scene = new THREE.Scene();
const windows = new WindowManager({ scene, store: null });
const place = (panel, placement) => {
  windows.add(panel, { id: panel.name, title: panel.name, placement });
  scene.updateMatrixWorld(true);
  return panel;
};

const convo = place(new ConversationPanel({ agentUrl: '/agent/ws', cwd: '/w', widthM: LAYOUT.conversation.widthM }), LAYOUT.conversation);
const ws = FakeWS.last;
const voice = place(new VoicePanel({ voice: { ready: true }, getTarget: () => convo, sttEnabled: true }), LAYOUT.voice);
const keyboard = place(new KeyboardPanel({ onSend() {} }), LAYOUT.keyboard);
const keys = place(quickKeys(() => {}, {}), LAYOUT.keys);
const snippets = place(snippetPanel([...Array(12)].map((_, i) => ({ label: `s${i}`, text: 'x' })), () => {}), LAYOUT.snippets);
// TerminalPanel imports xterm through the browser's import map, which Node can't
// resolve, so use a stand-in with its real size (1.3 m wide, 100x30 cells ~ 0.67 aspect).
const terminal = place(new Panel({ widthM: 1.3, heightM: 1.3 * 0.67, pxW: 1628, pxH: 1088, name: 'term 1' }), terminalPlacement(1));
const panels = windows.panels; // each window and its title bar

// ---- controls per panel (centres in canvas space, u/v in 0..1, v down) ----------------------
const centre = (r, p) => ({ u: (r.x + r.w / 2) / p.pxW, v: (r.y + r.h / 2) / p.pxH });

function conversationControls() {
  const found = [];
  const grab = (label) => { convo.draw(convo.ctx, convo.pxW, convo.pxH); for (const s of convo.spots) found.push({ name: `${label}: ${s.label}`, ...centre(s, convo) }); };
  grab('idle');
  convo.submit('do it');
  ws.emit(init);
  ws.emit(permissionRequest('p1', 'Bash', { command: 'touch x' }));
  grab('waiting'); // Allow / Always allow / Deny live here
  return found;
}

function voiceControls() {
  const found = [];
  for (const state of ['idle', 'recording', 'review', 'error']) {
    voice.state = state;
    voice.text = 'something I said';
    voice.voice.ready = true;
    for (const b of voice.buttons()) found.push({ name: `voice ${state}: ${b.label}`, ...centre(b, voice) });
  }
  return found;
}

const keyboardControls = () => keyboard.layout.map((r) => ({ name: `key ${r.k.label ?? r.k.key}`, ...centre(r, keyboard) }));

function gridControls(panel, label) {
  return panel.buttons.map((b, i) => {
    const r = { x: 10 + (i % panel.cols) * panel.colPx, y: 10 + Math.floor(i / panel.cols) * panel.rowPx, w: panel.colPx, h: panel.rowPx };
    return { name: `${label}: ${b.label}`, ...centre(r, panel) };
  });
}

const controls = new Map([
  [convo, conversationControls()],
  [voice, voiceControls()],
  [keyboard, keyboardControls()],
  [keys, gridControls(keys, 'keys')],
  [snippets, gridControls(snippets, 'snippet')],
  [terminal, [{ name: 'terminal centre', u: 0.5, v: 0.5 }, { name: 'terminal title', u: 0.5, v: 0.02 }]],
]);
// Each title bar: its drag area and its buttons must be reachable too.
for (const w of windows.windows) {
  const bar = w.bar;
  const list = [{ name: `${w.title} drag area`, u: 0.15, v: 0.5 }];
  for (const z of bar.zones()) list.push({ name: `${w.title} ${z.id} button`, u: (z.x0 + z.x1) / 2 / bar.pxW, v: 0.5 });
  controls.set(bar, list);
}

const EYES = [];
for (const y of [1.1, 1.4, 1.7]) for (const x of [-0.3, 0, 0.3]) EYES.push(new THREE.Vector3(x, y, 0));
const meshes = panels.map((p) => p.mesh);
const raycaster = new THREE.Raycaster();

function firstHit(eye, target) {
  raycaster.set(eye, target.clone().sub(eye).normalize());
  return raycaster.intersectObjects(meshes, false)[0]?.object.userData.panel ?? null;
}

for (const [panel, list] of controls) {
  test(`${panel.name}: every control is the first thing you see (${list.length} controls)`, () => {
    const g = panel.mesh.geometry.parameters;
    const hidden = [];
    for (const c of list) {
      const world = panel.mesh.localToWorld(new THREE.Vector3((c.u - 0.5) * g.width, (0.5 - c.v) * g.height, 0));
      for (const eye of EYES) {
        const hit = firstHit(eye, world);
        if (hit !== panel) hidden.push(`${c.name} (eye ${eye.x},${eye.y}) hidden behind ${hit?.name ?? 'nothing'}`);
      }
    }
    assert.deepEqual(hidden.slice(0, 8), [], `${hidden.length} occlusions`);
  });
}
