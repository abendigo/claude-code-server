// The flat web app's panes. Each function rebuilds one pane from the model;
// they hold no state of their own, so rendering again is always safe.
import { h, fill } from './dom.js';
import { renderMarkdown } from './markdown-dom.js';
import { headerStatus, activityRows, backgroundRows, fmtDuration } from '../activity.js';
import { visibleSessions, describeSession, asleepRows } from '../session-list.js';

const STATE_LABEL = { offline: 'offline', connecting: 'connecting', idle: 'ready', working: 'working', waiting: 'needs your answer' };

// ---- conversation -------------------------------------------------------------------
export function renderLog(el, convo, { showTools = false } = {}) {
  const items = [];
  for (const b of convo.blocks) {
    if (b.kind === 'user') items.push(h('div', { class: 'msg user' }, h('div', { class: 'who' }, 'You'), h('div', { class: 'body plain' }, b.text)));
    else if (b.kind === 'assistant') {
      items.push(h('div', { class: 'msg claude' }, h('div', { class: 'who' }, 'Claude'),
        h('div', { class: `body md${b.streaming ? ' streaming' : ''}` }, renderMarkdown(b.text))));
    } else if (b.kind === 'tool') {
      if (showTools) items.push(h('div', { class: `tool ${b.status}` }, b.summary));
    } else if (b.kind === 'permission') {
      const label = { pending: 'waiting for you', allowed: 'allowed', denied: 'denied', cancelled: 'cancelled' }[b.status];
      items.push(h('div', { class: `perm ${b.status}` }, `${b.text.split('\n').slice(-1)[0]} [${label}]`));
    } else items.push(h('div', { class: `notice ${b.level}` }, b.text));
  }
  if (!items.length) items.push(h('div', { class: 'empty' }, convo.status || (convo.state === 'connecting' ? 'Connecting…' : 'Say or type what you want Claude to do.')));
  fill(el, items);
}

// The approval bar above the composer: shown only while Claude waits for an answer.
export function renderApproval(el, convo, { onAnswer }) {
  const p = convo.state === 'waiting' ? convo.pending : null;
  el.hidden = !p;
  if (!p) return fill(el);
  fill(el,
    h('div', { class: 'ask' }, h('strong', {}, 'Claude wants to: '), h('code', {}, p.text.split('\n').slice(-1)[0] || p.text)),
    h('div', { class: 'buttons' },
      h('button', { class: 'allow', onclick: () => onAnswer('allow') }, 'Allow'),
      h('button', { class: 'always', onclick: () => onAnswer('always') }, 'Always allow'),
      h('button', { class: 'deny', onclick: () => onAnswer('deny') }, 'Deny')));
}

export function stateLabel(convo) {
  return convo.status && (convo.state === 'connecting' || convo.state === 'offline') ? convo.status : (STATE_LABEL[convo.state] ?? convo.state);
}

// ---- sessions -----------------------------------------------------------------------
// armed: the session whose End button was tapped once (a second tap ends it).
export function renderSessions(el, convo, now, { onNew, onSwitch, onEnd, onClear = null, armed, armedClear = false }) {
  const rows = visibleSessions(convo).map((r) => {
    const d = describeSession(r, convo, now);
    return h('li', { class: `row ${d.state}${d.current ? ' current' : ''}` },
      h('button', { class: 'pick', onclick: () => { if (!d.current) onSwitch(r); }, 'aria-current': d.current },
        h('span', { class: `dot ${d.state}`, 'aria-hidden': 'true' }),
        h('span', { class: 'text' }, h('span', { class: 'label' }, d.label), h('span', { class: 'detail' }, d.detail))),
      d.canEnd && h('button', { class: `end${armed === d.key ? ' armed' : ''}`, 'aria-label': 'End this session', onclick: () => onEnd(r) }, armed === d.key ? 'End?' : '×'));
  });
  fill(el,
    h('div', { class: 'pane-head' }, h('h2', {}, 'Sessions'), h('span', { class: 'actions' },
      onClear && asleepRows(convo).length ? h('button', { class: `clear${armedClear ? ' armed' : ''}`, onclick: onClear }, armedClear ? `Close ${asleepRows(convo).length}?` : 'Clear asleep') : null,
      h('button', { onclick: onNew }, 'New'))),
    rows.length ? h('ul', { class: 'sessions' }, rows) : h('p', { class: 'empty' }, 'No sessions yet.'));
}

// ---- activity -----------------------------------------------------------------------
// armedTask: the worker whose Stop was tapped once (a second tap stops it). onStopTask(id) stops it.
export function renderActivity(el, convo, now, { onStopTask = null, armedTask = null } = {}) {
  const st = headerStatus(convo, now);
  const workers = backgroundRows(convo, now).map((w) => h('li', { class: `worker ${w.status}` },
    h('span', { class: 'mark', 'aria-hidden': 'true' }),
    h('span', { class: 'what' }, h('span', { class: 'name' }, w.text), h('span', { class: 'sub' }, w.status === 'running' ? (w.last ? `using ${w.last}` : 'starting') : w.status === 'completed' ? (w.summary || 'finished') : w.status)),
    w.ms !== null && h('span', { class: 'time' }, fmtDuration(w.ms)),
    w.status === 'running' && onStopTask && h('button', { class: `stop${armedTask === w.id ? ' armed' : ''}`, onclick: () => onStopTask(w.id) }, armedTask === w.id ? 'Stop?' : 'Stop')));
  const rows = activityRows(convo, now).map((r) => {
    if (r.kind === 'turn') return h('li', { class: 'turn' }, r.text);
    if (r.kind === 'tool') return h('li', { class: `tool ${r.status}` }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', { class: 'what' }, r.text), r.ms !== null && h('span', { class: 'time' }, fmtDuration(r.ms)));
    return h('li', { class: r.kind }, r.kind === 'wait' ? `Waiting for you: ${r.text}` : r.text);
  });
  fill(el,
    h('div', { class: `status ${st.tone}` }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('strong', {}, st.label), st.time && h('span', { class: 'timer' }, st.time), st.detail && h('div', { class: 'detail' }, st.detail)),
    workers.length ? h('div', { class: 'workers' }, h('h2', {}, 'Workers'), h('ul', {}, workers)) : null,
    rows.length ? h('ol', { class: 'rows' }, rows) : h('p', { class: 'empty' }, 'Nothing yet. What Claude is doing will show here.'));
}

// ---- documents ----------------------------------------------------------------------
export function renderDocs(el, docs, selected, { onSelect }) {
  el.hidden = docs.size === 0;
  if (!docs.size) return fill(el);
  const current = docs.has(selected) ? selected : [...docs.keys()][0];
  fill(el,
    h('div', { class: 'tabs', role: 'tablist' }, [...docs].map(([id, d]) => h('button', { role: 'tab', class: id === current ? 'on' : '', 'aria-selected': id === current, onclick: () => onSelect(id) }, d.title))),
    h('div', { class: 'doc md' }, renderMarkdown(docs.get(current).text)));
}
