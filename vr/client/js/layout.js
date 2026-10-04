// Where each panel floats, in metres, in a local-floor reference space with
// the viewer at the origin looking down -z. Kept in its own file so a test can
// check that no clickable control is hidden behind another panel (see
// test/layout.test.mjs). Panels can still be grabbed and moved at runtime.
// Stacked top to bottom so nothing hides anything else: conversation, then the
// voice bar, then the keyboard; quick keys and snippets flank the voice bar.
export const LAYOUT = {
  conversation: { widthM: 1.3, pos: [0, 1.62, -1.45], rotX: 0, rotY: 0 },
  voice: { pos: [0, 0.86, -0.9], rotX: -0.3, rotY: 0 },
  keyboard: { pos: [0, 0.5, -0.7], rotX: -0.9, rotY: 0 },
  keys: { pos: [-1.25, 0.85, -0.85], rotX: -0.35, rotY: 0.5 },
  snippets: { pos: [1.25, 0.85, -0.85], rotX: -0.35, rotY: -0.5 },
};

// i-th terminal (1-based): alternating left/right of the conversation, turned toward the viewer.
export function terminalPlacement(i) {
  const side = i % 2 ? -1 : 1;
  const col = Math.ceil(i / 2) - 1;
  return { pos: [side * (1.65 + col * 1.1), 1.55, -1.0 - col * 0.2], rotX: 0, rotY: -side * 0.75 };
}
