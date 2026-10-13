// The conversation model following a session in the session service: attach,
// history replay (live log and transcript shapes), and what other viewers do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../client/js/conversation.js';
import { init, reply, toolUse, toolResult, result, permissionRequest } from './fixtures.mjs';

const sdk = (message, at) => ({ type: 'sdk', message, ...(at ? { at } : {}) });
const assistantText = (id, text, at) => sdk({ type: 'assistant', uuid: id, parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } }, at);
const assistantTool = (id, name, input, at) => sdk({ type: 'assistant', uuid: id, parent_tool_use_id: null, message: { id: 'm-' + id, content: [{ type: 'tool_use', id, name, input }] } }, at);
const userResult = (id, content, at) => sdk({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }, at);

// What the service logs for a live session.
const liveLog = [
  { type: 'sdk', message: init.message, at: 1000 },
  { type: 'user_prompt', text: 'run the tests', at: 2000 },
  assistantTool('t1', 'Bash', { command: 'npm test', description: 'Run the tests' }, 3000),
  userResult('t1', 'ok', 8000),
  assistantText('a1', 'All green.\n\n<spoken>The tests pass.</spoken>', 9000),
  sdk({ type: 'result', subtype: 'success', duration_ms: 7000, total_cost_usd: 0.02 }, 9100),
];

// What the SDK's transcript gives back: no timestamps, prompts as user messages with string content.
const transcript = [
  sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'run the tests' } }),
  assistantTool('t1', 'Bash', { command: 'npm test', description: 'Run the tests' }),
  userResult('t1', 'ok'),
  assistantText('a1', 'All green.\n\n<spoken>The tests pass.</spoken>'),
];

const attached = (state = 'idle', extra = {}) => ({ type: 'attached', session: 'svc1', sdkId: 'sess-1', cwd: '/workspace/proj', state, live: true, ...extra });

test('attached resets the view, remembers the session and takes its state', () => {
  const c = new Conversation();
  c.submit('old stuff');
  c.handle(attached('working'));
  assert.deepEqual(c.attach, { session: 'svc1', sdkId: 'sess-1', cwd: '/workspace/proj' });
  assert.equal(c.sessionId, 'sess-1');
  assert.equal(c.blocks.length, 0);
  assert.equal(c.state, 'working');
  c.handle(attached('waiting'));
  assert.equal(c.state, 'waiting');
  c.handle(attached('nonsense'));
  assert.equal(c.state, 'idle');
});

test('history from the live log: prompts, tool calls with durations, the reply without its spoken tag', () => {
  const spoken = [];
  const c = new Conversation({ onSpeak: (t) => spoken.push(t) });
  c.handle(attached());
  c.handle({ type: 'history', messages: liveLog });
  assert.deepEqual(c.blocks.map((b) => b.kind), ['user', 'tool', 'assistant']);
  assert.equal(c.blocks[0].text, 'run the tests');
  const tool = c.blocks[1];
  assert.deepEqual([tool.summary, tool.status, tool.started, tool.ended], ['Run the tests', 'ok', 3000, 8000]);
  assert.equal(c.blocks[2].text, 'All green.');
  assert.equal(c.turnStarted, 2000);
  assert.equal(c.turnEnded, 9100);
  assert.equal(c.model, 'test-model');
  assert.deepEqual(spoken, [], 'replaying the past never speaks');
});

test('history from a transcript: no timestamps, prompts come back as user messages', () => {
  const c = new Conversation();
  c.handle(attached());
  c.handle({ type: 'history', messages: transcript });
  assert.deepEqual(c.blocks.map((b) => b.kind), ['user', 'tool', 'assistant']);
  assert.equal(c.blocks[0].text, 'run the tests');
  assert.equal(c.blocks[1].started, null);
  assert.equal(c.blocks[1].status, 'ok');
});

test('history ignores subagent internals, stream events and empty text', () => {
  const c = new Conversation();
  c.handle(attached());
  c.handle({ type: 'history', messages: [
    sdk({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 's', content: [{ type: 'text', text: 'inner' }] } }),
    sdk({ type: 'stream_event', event: { type: 'message_start' } }),
    sdk({ type: 'user', message: { role: 'user', content: '   ' } }),
    { type: 'something_else' },
    assistantText('a1', 'Visible.'),
  ] });
  assert.deepEqual(c.blocks.map((b) => b.text), ['Visible.']);
});

test('a tool still running in a finished session does not spin forever; in a working one it does', () => {
  const log = [{ type: 'user_prompt', text: 'go', at: 1 }, assistantTool('t1', 'Bash', { command: 'sleep 99' }, 2)];
  const idle = new Conversation();
  idle.handle(attached('idle'));
  idle.handle({ type: 'history', messages: log });
  assert.equal(idle.blocks.find((b) => b.kind === 'tool').status, 'ok');
  const busy = new Conversation();
  busy.handle(attached('working'));
  busy.handle({ type: 'history', messages: log });
  assert.equal(busy.blocks.find((b) => b.kind === 'tool').status, 'running');
});

test('history replaces what was there, and live messages carry on from it', () => {
  const c = new Conversation();
  c.handle(attached('working'));
  c.handle({ type: 'history', messages: liveLog.slice(0, 3) }); // mid-turn: a tool call is running
  c.handle(permissionRequest('p1', 'Bash', { command: 'rm x' })); // re-sent by the service on attach
  assert.equal(c.state, 'waiting');
  assert.equal(c.pending.id, 'p1');
  c.answer(true);
  [toolResult('t1', 'ok'), ...reply('a2', 'Done now.'), result()].flat().forEach((m) => c.handle(m));
  assert.equal(c.state, 'idle');
  assert.equal(c.blocks.at(-1).text, 'Done now.');
  c.handle({ type: 'history', messages: transcript }); // switching session: replaced wholesale
  assert.equal(c.blocks.length, 3);
  assert.equal(c.pending, null);
});

test('a prompt typed in another viewer shows here and starts the turn', () => {
  const c = new Conversation();
  c.handle(attached());
  c.handle({ type: 'history', messages: [] });
  c.handle({ type: 'user_prompt', text: 'from my laptop', at: 5000 });
  assert.deepEqual(c.blocks.map((b) => [b.kind, b.text]), [['user', 'from my laptop']]);
  assert.equal(c.state, 'working');
  assert.equal(c.turnStarted, 5000);
});

test('session_state follows the service, but only for this session and never over a pending approval', () => {
  const c = new Conversation();
  c.handle(attached());
  c.handle({ type: 'session_state', session: 'svc1', state: 'working' });
  assert.equal(c.state, 'working');
  c.handle({ type: 'session_state', session: 'other', state: 'idle' });
  assert.equal(c.state, 'working', 'another session');
  c.handle(permissionRequest('p1', 'Bash', { command: 'ls' }));
  c.handle({ type: 'session_state', session: 'svc1', state: 'working' });
  assert.equal(c.state, 'waiting', 'an approval is pending, so we are waiting');
  c.answer(false);
  c.handle({ type: 'session_state', session: 'svc1', state: 'idle' });
  assert.equal(c.state, 'idle');
  c.setState('offline');
  c.handle({ type: 'session_state', session: 'svc1', state: 'working' });
  assert.equal(c.state, 'offline', 'a dropped connection stays dropped until it reconnects');
});

test('the session list is kept, and junk is ignored', () => {
  const c = new Conversation();
  c.handle({ type: 'sessions', list: [{ session: 's', summary: 'x' }] });
  assert.equal(c.sessions.length, 1);
  c.handle({ type: 'sessions', list: 'nope' });
  assert.deepEqual(c.sessions, []);
});

test('a reply that finishes streaming is flagged once; replayed replies are not', () => {
  const live = new Conversation();
  [init, ...reply('a1', 'Hello there friend'), result()].flat().forEach((m) => live.handle(m));
  assert.equal(live.blocks.filter((b) => b.justFinished).length, 1);
  const replayed = new Conversation();
  replayed.handle(attached());
  replayed.handle({ type: 'history', messages: transcript });
  assert.equal(replayed.blocks.filter((b) => b.justFinished).length, 0);
});
