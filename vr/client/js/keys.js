// Translate a DOM keydown into the bytes a terminal expects, or null if the
// key isn't ours (browser shortcuts, bare modifiers). Used for physical and
// Bluetooth keyboards, in both flat and immersive mode.
const NAMED = {
  Enter: '\r', Backspace: '\x7f', Escape: '\x1b',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  Delete: '\x1b[3~', Insert: '\x1b[2~',
};

export function keyToSequence(e) {
  if (e.metaKey) return null;
  const k = e.key;
  if (k === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
  if (NAMED[k]) return NAMED[k];
  if ([...k].length !== 1) return null; // Shift, Control, F-keys, Dead, ...
  if (e.ctrlKey) {
    const c = k.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    if (k === '[') return '\x1b';
    if (k === '\\') return '\x1c';
    if (k === ']') return '\x1d';
    return null;
  }
  return e.altKey ? '\x1b' + k : k;
}
