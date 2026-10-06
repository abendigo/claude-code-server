import test from 'node:test';
import assert from 'node:assert/strict';

const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { parseMarkdown, inline } = await import('../client/js/markdown.js');
const { MarkdownPanel } = await import('../client/js/markdown-panel.js');

test('inline markup is flattened to plain text', () => {
  assert.equal(inline('a **bold** and *italic* and `code` here'), 'a bold and italic and code here');
  assert.equal(inline('see [the docs](https://x.example/y) now'), 'see the docs now');
  assert.equal(inline('![logo](a.png) text'), 'logo text');
  assert.equal(inline('2 * 3 * 4'), '2 * 3 * 4', 'a lone asterisk is not emphasis');
  assert.equal(inline('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(inline('line<br>two'), 'line\ntwo');
});

test('headings, paragraphs and rules', () => {
  const b = parseMarkdown('# Title\n\nfirst line\nsecond line\n\n### Sub ###\n\n---\n');
  assert.deepEqual(b, [
    { t: 'h', level: 1, text: 'Title' },
    { t: 'p', text: 'first line second line' },
    { t: 'h', level: 3, text: 'Sub' },
    { t: 'hr' },
  ]);
});

test('lists: bullets, numbers, nesting and wrapped continuation lines', () => {
  const b = parseMarkdown('- one\n  - nested\n1. first\n2) second\n- long item that\n  continues here\n');
  assert.deepEqual(b.map((x) => [x.t, x.depth, x.marker, x.text]), [
    ['li', 0, '-', 'one'],
    ['li', 1, '-', 'nested'],
    ['li', 0, '1.', 'first'],
    ['li', 0, '2)', 'second'],
    ['li', 0, '-', 'long item that continues here'],
  ]);
});

test('code fences keep their lines and ignore markdown inside', () => {
  const b = parseMarkdown('before\n```js\n# not a heading\n- not a list\n```\nafter');
  assert.deepEqual(b, [
    { t: 'p', text: 'before' },
    { t: 'code', lines: ['# not a heading', '- not a list'] },
    { t: 'p', text: 'after' },
  ]);
});

test('an unclosed fence takes the rest of the document instead of looping', () => {
  assert.deepEqual(parseMarkdown('```\na\nb'), [{ t: 'code', lines: ['a', 'b'] }]);
});

test('quotes join their lines', () => {
  assert.deepEqual(parseMarkdown('> one\n> two\n\nafter'), [{ t: 'quote', text: 'one two' }, { t: 'p', text: 'after' }]);
});

test('tables drop the separator row', () => {
  const b = parseMarkdown('| a | b |\n|---|:-:|\n| 1 | **2** |\n| 3 | 4 |\n\nafter');
  assert.deepEqual(b[0], { t: 'table', rows: [['a', 'b'], ['1', '2'], ['3', '4']] });
  assert.deepEqual(b[1], { t: 'p', text: 'after' });
});

test('empty and odd input never throws', () => {
  for (const s of ['', null, undefined, '\n\n', '|', '| a |', '#', '>', '-', '```', '\r\n# x\r\n']) assert.doesNotThrow(() => parseMarkdown(s), String(s));
});

test('a long document lays out, draws, and scrolls within bounds', () => {
  const doc = Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\nSome paragraph text that is long enough to wrap onto more than one line when drawn in the window, number ${i}.\n\n- point a\n- point b\n`).join('\n');
  const p = new MarkdownPanel({ text: doc });
  p.update();
  assert.ok(p.laid.height > p.pxH * 5, 'taller than the window, so it scrolls');
  p.onScroll(-5);
  assert.equal(p.scroll, 0, 'cannot scroll above the top');
  p.onScroll(1e6);
  p.update();
  assert.equal(p.scroll, p.laid.height - p.pxH, 'cannot scroll past the end');
  p.set('# short');
  p.update();
  assert.equal(p.scroll, 0, 'a short replacement document is back at the top');
});

test('a very long unbroken line does not hang layout', () => {
  const p = new MarkdownPanel({ text: `# x\n\n${'a'.repeat(20000)}\n\n\`\`\`\n${'b'.repeat(20000)}\n\`\`\`` });
  p.update();
  assert.ok(p.laid.items.length > 0);
});
