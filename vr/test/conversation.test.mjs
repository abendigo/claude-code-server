import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, summarizeTool, describePermission } from '../client/js/conversation.js';
import { init, reply, toolUse, toolResult, thinking, result, permissionRequest } from './fixtures.mjs';

const feed = (c, msgs) => msgs.flat().forEach((m) => c.handle(m));

test('streamed text is one block, finalised by the complete message (no duplicates)', () => {
  const c = new Conversation();
  feed(c, [init, reply('a1', 'Hello there friend')]);
  const texts = c.blocks.filter((b) => b.kind === 'assistant');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'Hello there friend');
  assert.equal(texts[0].streaming, false);
  assert.equal(c.sessionId, 'sess-1');
});

test('text is visible while still streaming', () => {
  const c = new Conversation();
  const msgs = reply('a1', 'one two three');
  feed(c, [init, ...msgs.slice(0, 4)]); // message_start, block_start, two deltas
  assert.equal(c.blocks[0].streaming, true);
  assert.equal(c.blocks[0].text, 'one two');
});

test('thinking blocks and empty text are not shown', () => {
  const c = new Conversation();
  feed(c, [init, thinking]);
  assert.equal(c.blocks.length, 0);
});

test('tool call: running, then ok with output', () => {
  const c = new Conversation();
  feed(c, [init, toolUse('t1', 'Bash', { command: 'npm test', description: 'Run the tests' })]);
  assert.deepEqual([c.blocks[0].kind, c.blocks[0].status, c.blocks[0].summary], ['tool', 'running', 'Run the tests']);
  c.handle(toolResult('t1', 'all passed'));
  assert.deepEqual([c.blocks[0].status, c.blocks[0].detail], ['ok', 'all passed']);
});

test('tool error is marked', () => {
  const c = new Conversation();
  feed(c, [init, toolUse('t1', 'Bash', { command: 'false' }), toolResult('t1', [{ type: 'text', text: 'boom' }], true)]);
  assert.deepEqual([c.blocks[0].status, c.blocks[0].detail], ['error', 'boom']);
});

test('permission flow: waiting -> answer -> working -> idle', () => {
  const c = new Conversation();
  const sent = c.submit('please touch a file');
  assert.deepEqual(sent, { type: 'prompt', text: 'please touch a file' });
  assert.equal(c.state, 'working');
  feed(c, [init, toolUse('t1', 'Bash', { command: 'touch x' }), permissionRequest('p1', 'Bash', { command: 'touch x' })]);
  assert.equal(c.state, 'waiting');
  assert.equal(c.pending.id, 'p1');
  assert.match(c.pending.text, /touch x/);

  assert.deepEqual(c.answer(true, true), { type: 'permission', id: 'p1', allow: true, always: true });
  assert.equal(c.state, 'working');
  assert.equal(c.pending, null);
  assert.equal(c.blocks.find((b) => b.kind === 'permission').status, 'allowed');

  feed(c, [toolResult('t1', 'ok'), reply('a2', 'Done'), result()]);
  assert.equal(c.state, 'idle');
  assert.equal(c.last.ms, 4321);
});

test('deny never sets always, and answering with nothing pending does nothing', () => {
  const c = new Conversation();
  assert.equal(c.answer(true), null);
  c.handle(permissionRequest('p1', 'Bash', { command: 'rm x' }));
  assert.deepEqual(c.answer(false, true), { type: 'permission', id: 'p1', allow: false, always: false });
  assert.equal(c.blocks[0].status, 'denied');
});

test('connection loss cancels a pending approval and goes offline', () => {
  const c = new Conversation();
  c.handle(permissionRequest('p1', 'Bash', { command: 'x' }));
  c.handle({ type: 'exit', code: 1 });
  assert.equal(c.state, 'offline');
  assert.equal(c.blocks[0].status, 'cancelled');
  assert.equal(c.pending, null);
});

test('errors become notices; gateway status text is kept for the empty state', () => {
  const c = new Conversation();
  c.handle({ type: 'status', text: 'creating environment...' });
  assert.equal(c.status, 'creating environment...');
  c.handle({ type: 'error', message: 'bad thing' });
  assert.deepEqual([c.blocks[0].kind, c.blocks[0].level], ['notice', 'error']);
  c.handle(init);
  assert.equal(c.status, '');
});

test('failed turn is reported', () => {
  const c = new Conversation();
  c.handle(result({ subtype: 'error_max_turns', is_error: true }));
  assert.equal(c.state, 'idle');
  assert.match(c.blocks.at(-1).text, /error_max_turns/);
});

test('subagent internals (parent_tool_use_id set) are ignored', () => {
  const c = new Conversation();
  c.handle({ type: 'sdk', message: { type: 'assistant', parent_tool_use_id: 'x', message: { id: 's', content: [{ type: 'text', text: 'inner' }] } } });
  assert.equal(c.blocks.length, 0);
});

test('empty submit is ignored; submit carries cwd and resume only when given', () => {
  const c = new Conversation();
  assert.equal(c.submit('   '), null);
  assert.deepEqual(c.submit('hi', { cwd: '/w', resume: 'r1' }), { type: 'prompt', text: 'hi', cwd: '/w', resume: 'r1' });
});

test('summaries and permission wording', () => {
  assert.equal(summarizeTool('Edit', { file_path: '/a/b/main.js' }), 'Edit main.js');
  assert.equal(summarizeTool('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(summarizeTool('Grep', { pattern: 'foo' }), 'Search foo');
  assert.match(describePermission({ tool: 'Write', input: { file_path: '/a/x.txt' } }), /Write \/a\/x.txt/);
  assert.equal(describePermission({ title: 'Claude wants to read foo.txt', tool: 'Read' }), 'Claude wants to read foo.txt');
});
