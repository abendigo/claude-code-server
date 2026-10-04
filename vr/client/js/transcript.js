// Clean-up of raw speech-to-text output before it reaches a terminal.
// Pure functions, no DOM: easy to test and to tweak live via vr-sync.

// Words the recogniser keeps getting wrong, applied in every mode.
const FIXES = [
  [/\bclaw?ed\b/gi, 'claude'],
  [/\bclod\b/gi, 'claude'],
  [/\bclaud\b/gi, 'claude'],
  [/\bcloud code\b/gi, 'claude code'],
  [/\bget hub\b/gi, 'github'],
  [/\bt mux\b/gi, 'tmux'],
];

// Spoken punctuation for Command mode. "dash"/"double dash" make a flag
// ("ls dash la" -> "ls -la"); "hyphen" joins words ("claude hyphen code" ->
// "claude-code"). Speech can't tell those apart, so they get different words.
const SYMBOLS = [
  [/\s*\bdouble dash\b\s*/gi, ' --'],
  [/\s*\bdash[\s-]+dash\b\s*/gi, ' --'],
  [/\s*\bdash\b\s*/gi, ' -'],
  [/\s*\bhyphen\b\s*/gi, '-'],
  [/\s*\bunderscore\b\s*/gi, '_'],
  [/\s*\bslash\b\s*/gi, '/'],
  [/\s*\bdot\b\s*/gi, '.'],
  [/\s*\bpipe\b\s*/gi, ' | '],
  [/\s*\btilde\b\s*/gi, ' ~'],
];

// "C L A U D E", "C. L. A. U. D. E.", "c-l-a-u-d-e" -> "claude". Needs three or
// more single letters in a row so ordinary "a" / "I" aren't touched.
const SPELLED = /(?<![A-Za-z])(?:[A-Za-z][.,-]?\s*[.,-]?\s+){2,}[A-Za-z][.,-]?(?![A-Za-z])|(?<![A-Za-z])(?:[A-Za-z]-){2,}[A-Za-z](?![A-Za-z])/g;

export function collapseSpelling(text) {
  return text.replace(SPELLED, (m) => m.replace(/[^A-Za-z]/g, '').toLowerCase());
}

// mode 'command': shell-friendly (lowercase, no trailing punctuation, spoken
// symbols). mode 'prompt': prose for Claude, left as spoken apart from fixes.
export function cleanTranscript(raw, mode = 'prompt') {
  let t = collapseSpelling(raw.trim());
  for (const [re, to] of FIXES) t = t.replace(re, to);
  if (mode === 'command') {
    // The recogniser punctuates like prose ("Claude, dash, dash, resume.").
    // Shell commands have no commas, and a period only matters inside a word
    // (foo.txt), so drop sentence punctuation before reading the spoken symbols.
    t = t.replace(/[,;]+/g, ' ').replace(/[.!?]+(?=\s|$)/g, '');
    for (const [re, to] of SYMBOLS) t = t.replace(re, to);
    t = t.trim().replace(/ {2,}/g, ' ');
    t = t.toLowerCase().replace(/[.,!?;:\s]+$/, '').replace(/ {2,}/g, ' ');
  }
  return t;
}
