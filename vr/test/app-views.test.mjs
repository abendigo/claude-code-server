// The flat web app's panes, rendered into a small fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, all, byTag, byClass, button, El } from './fake-dom.mjs';

installDom();
const { renderLog, renderApproval, renderSessions, renderActivity, renderDocs, stateLabel } = await import('../client/js/app/views.js');
const { renderMarkdown } = await import('../client/js/app/markdown-dom.js');
const { sendPrompt, answerApproval, stopWork } = await import('../client/js/app/actions.js');
const { Conversation } = await import('../client/js/conversation.js');
const { init, reply, toolUse, toolResult, result, permissionRequest } = await import('./fixtures.mjs');

const feed = (c, msgs) => msgs.flat().forEach((m) => c.handle(m));
const box = () => new El('div');
const NOW = 10_000_000;

test('markdown becomes elements: headings, one list per run of items, code, quotes, tables', () => {
  const root = box();
  root.append(...renderMarkdown('# Title\n\nSome *text*.\n\n- one\n- two\n\n1. first\n2. second\n\n```\ncode here\n```\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |'));
  assert.deepEqual(all(root).filter((e) => /^(H\d|UL|OL|PRE|BLOCKQUOTE|TABLE)$/.test(e.tagName)).map((e) => e.tagName), ['H2', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE']);
  assert.equal(byTag(root, 'li').length, 4);
  assert.equal(byTag(root, 'code')[0].textContent, 'code here');
  assert.deepEqual(byTag(root, 'th').map((e) => e.textContent), ['a', 'b']);
  assert.match(root.textContent, /Some text\./);
});

test('text is never turned into markup', () => {
  const root = box();
  root.append(...renderMarkdown('Hello <img src=x onerror="alert(1)"> and <script>bad()</script> there'));
  assert.equal(byTag(root, 'img').length + byTag(root, 'script').length, 0);
  const log = box();
  const c = new Conversation();
  c.submit('<b>not bold</b>');
  renderLog(log, c);
  assert.equal(byTag(log, 'b').length, 0);
  assert.match(log.textContent, /<b>not bold<\/b>/);
});

test('the conversation log: your messages, Claude\'s replies as markdown; tool cards only when asked', () => {
  const c = new Conversation();
  feed(c, [init]);
  c.submit('run it');
  feed(c, [toolUse('t1', 'Bash', { command: 'ls', description: 'List files' }), toolResult('t1', 'ok'), ...reply('a1', 'Done.\n\n- one\n- two\n\n<spoken>All done.</spoken>'), result()]);
  const log = box();
  renderLog(log, c);
  assert.deepEqual(byClass(log, 'msg').map((e) => e.className), ['msg user', 'msg claude']);
  assert.equal(byTag(log, 'li').length, 2);
  assert.ok(!log.textContent.includes('All done.'), 'the spoken summary is not shown');
  assert.ok(!log.textContent.includes('List files'), 'tool calls live in the Activity pane');
  renderLog(log, c, { showTools: true });
  assert.match(log.textContent, /List files/);
});

test('the log says what is going on when empty', () => {
  const c = new Conversation();
  c.setState('connecting');
  const log = box();
  renderLog(log, c);
  assert.match(log.textContent, /Connecting/);
  c.setState('idle');
  renderLog(log, c);
  assert.match(log.textContent, /type what you want/);
  c.status = 'Reconnecting…';
  renderLog(log, c);
  assert.match(log.textContent, /Reconnecting/);
});

test('the approval bar appears only while waiting, and its buttons answer', () => {
  const c = new Conversation();
  feed(c, [init]);
  const bar = box();
  const answers = [];
  renderApproval(bar, c, { onAnswer: (k) => answers.push(k) });
  assert.equal(bar.hidden, true);
  c.submit('go');
  c.handle(permissionRequest('p1', 'Bash', { command: 'rm -rf build', description: 'Remove the build folder' }));
  renderApproval(bar, c, { onAnswer: (k) => answers.push(k) });
  assert.equal(bar.hidden, false);
  assert.match(bar.textContent, /rm -rf build/);
  for (const label of ['Allow', 'Always allow', 'Deny']) button(bar, label).click();
  assert.deepEqual(answers, ['allow', 'always', 'deny']);
});

test('state label prefers the reconnect message while not connected', () => {
  const c = new Conversation();
  c.setState('working');
  assert.equal(stateLabel(c), 'working');
  c.setState('connecting');
  c.status = 'Reconnecting…';
  assert.equal(stateLabel(c), 'Reconnecting…');
});

const row = (extra = {}) => ({ session: 's1', sdkId: 'k1', cwd: '/workspace', summary: 'Fix the keyboard', lastModified: NOW - 120_000, state: 'idle', viewers: 1, ...extra });

test('sessions: rows for this folder, the current one marked, switch and New', () => {
  const c = new Conversation();
  c.attach = { session: 's1', cwd: '/workspace' };
  c.sessions = [row(), row({ session: 's2', summary: 'Plan the service', state: 'working' }), row({ session: null, sdkId: 'k3', summary: 'Asleep', state: 'dormant' }), row({ session: 's9', summary: 'Elsewhere', cwd: '/other' })];
  const el = box();
  const calls = [];
  const handlers = { onNew: () => calls.push('new'), onSwitch: (r) => calls.push(`switch ${r.session ?? r.sdkId}`), onEnd: (r) => calls.push(`end ${r.session}`), armed: null };
  renderSessions(el, c, NOW, handlers);
  assert.equal(byTag(el, 'li').length, 3);
  assert.ok(!el.textContent.includes('Elsewhere'));
  assert.match(el.textContent, /ready · 2m ago · this one/);
  assert.equal(byClass(el, 'current').length, 1);
  const picks = byClass(el, 'pick');
  picks[0].click(); // the current one: nothing
  picks[1].click();
  picks[2].click();
  button(el, 'New').click();
  assert.deepEqual(calls, ['switch s2', 'switch k3', 'new']);
  const ends = byClass(el, 'end');
  assert.equal(ends.length, 2, 'a session the service does not hold has no End button');
  ends[0].click();
  assert.equal(calls.at(-1), 'end s1');
  renderSessions(el, c, NOW, { ...handlers, armed: 's2' });
  assert.equal(byClass(el, 'armed')[0].textContent, 'End?');
});

test('activity: status, timer, rows with marks and durations', () => {
  const c = new Conversation({ now: () => NOW });
  feed(c, [init]);
  c.submit('go');
  feed(c, [toolUse('t1', 'Read', { file_path: '/w/a.js' }), toolResult('t1', 'x'), toolUse('t2', 'Bash', { command: 'false' }), toolResult('t2', 'no', true), toolUse('t3', 'Grep', { pattern: 'foo' })]);
  const el = box();
  renderActivity(el, c, NOW + 42_000);
  assert.match(el.textContent, /Working/);
  assert.match(el.textContent, /42s/);
  assert.deepEqual(byClass(el, 'tool').map((e) => e.className), ['tool ok', 'tool error', 'tool running']);
  assert.match(el.textContent, /Search foo/);
  renderActivity(el, new Conversation(), NOW);
  assert.match(el.textContent, /Nothing yet/);
});

test('documents: hidden when none, tabs when several, the selected one is shown', () => {
  const el = box();
  const docs = new Map();
  renderDocs(el, docs, null, { onSelect() {} });
  assert.equal(el.hidden, true);
  docs.set('a', { title: 'Handoff', text: '# First doc' });
  docs.set('b', { title: 'To do', text: '# Second doc\n\n- item' });
  const picked = [];
  renderDocs(el, docs, 'b', { onSelect: (id) => picked.push(id) });
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /Second doc/);
  assert.ok(!el.textContent.includes('First doc'));
  button(el, 'Handoff').click();
  assert.deepEqual(picked, ['a']);
  renderDocs(el, docs, 'gone', { onSelect() {} });
  assert.match(el.textContent, /First doc/, 'a vanished selection falls back to the first');
});

test('actions: send, answer, stop', () => {
  const sent = [];
  const client = { legacy: false, send: (m) => { sent.push(m); return Boolean(m); } };
  const c = new Conversation();
  assert.equal(sendPrompt(c, client, '   '), false);
  assert.equal(sendPrompt(c, client, ' hello ', { cwd: '/w', resumeId: 'sess-1' }), true);
  assert.deepEqual(sent[0], { type: 'prompt', text: 'hello', cwd: '/w' }, 'no resume id with the session service');
  client.legacy = true;
  sendPrompt(c, client, 'again', { cwd: '/w', resumeId: 'sess-1' });
  assert.equal(sent[1].resume, 'sess-1', 'an old worker needs it');
  c.handle(permissionRequest('p1', 'Bash', { command: 'ls' }));
  assert.equal(sendPrompt(c, client, 'blocked'), false);
  assert.match(c.blocks.at(-1).text, /Answer the approval first/);
  answerApproval(c, client, 'always');
  assert.deepEqual(sent.at(-1), { type: 'permission', id: 'p1', allow: true, always: true });
  stopWork(client);
  assert.deepEqual(sent.at(-1), { type: 'interrupt' });
});
