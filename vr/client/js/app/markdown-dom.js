// Markdown blocks (from markdown.js) as DOM elements for the flat web app.
import { parseMarkdown } from '../markdown.js';
import { h } from './dom.js';

export function renderBlocks(blocks) {
  const out = [];
  let list = null; // consecutive list items share one <ul>/<ol>
  for (const b of blocks) {
    if (b.t === 'li') {
      const ordered = b.marker !== '-';
      if (!list || list.ordered !== ordered) { list = { ordered, el: h(ordered ? 'ol' : 'ul') }; out.push(list.el); }
      list.el.appendChild(h('li', { class: `depth${b.depth}` }, b.text));
      continue;
    }
    list = null;
    if (b.t === 'h') out.push(h(`h${Math.min(6, b.level + 1)}`, {}, b.text)); // h1 in a reply is still a sub-heading of the page
    else if (b.t === 'p') out.push(h('p', {}, b.text));
    else if (b.t === 'quote') out.push(h('blockquote', {}, b.text));
    else if (b.t === 'code') out.push(h('pre', {}, h('code', {}, b.lines.join('\n'))));
    else if (b.t === 'hr') out.push(h('hr'));
    else if (b.t === 'table') {
      const [head, ...rows] = b.rows;
      out.push(h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
    }
  }
  return out;
}

export const renderMarkdown = (text) => renderBlocks(parseMarkdown(text));
