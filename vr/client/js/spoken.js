// What gets said out loud. Pure text handling (no DOM, no speech engine), so it
// can be tested. Claude is asked (agent/bridge.mjs) to end each reply with a
// short <spoken>...</spoken> summary; that tag is stripped from what is shown
// and is what gets spoken. If a reply has no tag, the first couple of
// sentences are spoken instead.
const TAG = /<spoken>([\s\S]*?)<\/spoken>/i;

// Separate a reply into the text to display and the text to speak. Also hides a
// tag that is still streaming in, so it never flashes on screen half-written.
export function splitSpoken(raw) {
  let text = String(raw ?? '');
  let spoken = null;
  const m = TAG.exec(text);
  if (m) { spoken = m[1].trim() || null; text = text.replace(TAG, ''); }
  text = text.replace(/<spoken>[\s\S]*$/i, '').replace(/<(?:s(?:p(?:o(?:k(?:e(?:n)?)?)?)?)?)?$/i, '');
  return { text: text.trimEnd(), spoken };
}

// Make text fit for a speech engine: no code, links or markdown marks, and short.
export function speakable(text, max = 400) {
  const t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 3 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')).trimEnd() + '.';
}

// For a reply that has no <spoken> tag: its first two sentences.
export function fallbackSpoken(text) {
  const sentences = speakable(text, 10000).match(/.+?(?:[.!?]+(?=\s|$)|$)/g) ?? [];
  return speakable(sentences.slice(0, 2).join(' ').trim(), 240);
}
