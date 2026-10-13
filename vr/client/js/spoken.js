// What gets said out loud. Pure text handling (no DOM, no speech engine), so it
// can be tested. Claude is asked (agent/service.mjs) to end each reply with a
// short <spoken>...</spoken> summary; that tag is stripped from what is shown
// and is what gets spoken. If a reply has no tag, the first couple of
// sentences are spoken instead.
// A summary is a <spoken>...</spoken> pair. A reply that merely MENTIONS the tag
// (in prose, or in `backticks`) must keep its text, so a pair counts only when it
// is not wrapped in backticks and contains no other opening tag.
const PAIR = /(?<!`)<spoken>((?:(?!<spoken>)[\s\S])*?)<\/spoken>(?!`)/gi;
// A summary still streaming in: the last opening tag, never closed, short, within one paragraph.
const OPEN_TAIL = /(?<!`)<spoken>(?![\s\S]*<\/spoken>)(?!(?:[\s\S]*<spoken>))([\s\S]*)$/i;
const MAX_STREAMING_SUMMARY = 700;

// Separate a reply into the text to display and the text to speak. Also hides a
// tag that is still streaming in, so it never flashes on screen half-written.
export function splitSpoken(raw) {
  let text = String(raw ?? '');
  let spoken = null;
  let last = null;
  for (const m of text.matchAll(PAIR)) last = m;
  if (last) {
    spoken = last[1].trim() || null;
    text = text.slice(0, last.index) + text.slice(last.index + last[0].length);
  } else {
    const open = OPEN_TAIL.exec(text);
    if (open && open[1].length <= MAX_STREAMING_SUMMARY && !/\n\s*\n/.test(open[1])) text = text.slice(0, open.index);
  }
  text = text.replace(/<(?:s(?:p(?:o(?:k(?:e(?:n)?)?)?)?)?)?$/i, '');
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
