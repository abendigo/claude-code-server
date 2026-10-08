// A small markdown reader for windows: enough for notes, handoff files and READMEs.
// Pure (no canvas), so it can be tested. Produces a flat list of blocks; the panel
// decides how to lay them out. Inline markup is flattened to plain text, because
// the panel draws one font per block.
//
// Blocks: {t:'h', level, text} {t:'p', text} {t:'li', depth, marker, text}
//         {t:'quote', text} {t:'code', lines} {t:'hr'} {t:'table', rows}

// Strip inline markup: **bold**, *italic*, `code`, [text](url), ~~strike~~, <br>.
export function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');
}

const isTableSeparator = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', text: inline(para.join(' ')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      blocks.push({ t: 'code', lines: code });
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, text: inline(h[2]) }); continue; }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const rows = [splitRow(line)];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      i--;
      blocks.push({ t: 'table', rows });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const parts = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) parts.push(lines[++i].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', text: inline(parts.join(' ')) });
      continue;
    }

    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      let text = li[3];
      // A wrapped continuation line (indented, not itself a list item) belongs to this item.
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
      blocks.push({ t: 'li', depth: Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2)), marker: /\d/.test(li[2]) ? li[2] : '-', text: inline(text) });
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return blocks;
}
