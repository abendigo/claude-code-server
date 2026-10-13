// A manual check against the REAL Agent SDK and your Claude login (not part of `node --test`).
// Costs a few cents. Run: node agent/test/background.smoke.mjs
//
// Asks the questions background workers (Step 2) depend on:
//   1. Does the main session hand a slow job to a background worker and answer straight away?
//   2. Which messages tell us a worker started, progressed and finished?
//   3. When the worker finishes while the main session is idle, does the main session wake up
//      by itself and report, or does it wait for the next user message?
// It prints a timeline; read it.
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Inbox } from '../session.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
const DELEGATION = [
  'For work that will take more than a few seconds (running a build or the tests, searching or editing many files, research),',
  'hand it to the `worker` agent with the Agent tool instead of doing it yourself, then answer the user straight away in one short sentence',
  'saying what you started, so they can keep talking to you. When a worker finishes you will be told; then tell the user the result in one or two sentences.',
].join(' ');
const inbox = new Inbox();
const q = query({
  prompt: inbox,
  options: {
    cwd: dir,
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: DELEGATION },
    agents: {
      worker: {
        description: 'Does a slow job in the background (builds, tests, bulk edits, research) and reports the result in one short sentence.',
        prompt: 'You are a background worker. Do exactly what you are asked, then reply with one short sentence saying what you did and the result.',
        background: true,
        model: 'haiku',
        tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      },
    },
  },
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const log = [];
const note = (kind, text = '') => { log.push({ at: (Date.now() - t0) / 1000, kind }); console.log(`${at()}  ${kind.padEnd(26)} ${text}`); };
let turnsEnded = 0;
let wokeByItself = false;

(async () => {
  for await (const m of q) {
    if (m.type === 'system') {
      if (m.subtype === 'init') note('init', m.session_id);
      else if (m.subtype === 'task_started') note('task_started', `${m.task_type ?? ''} bg=${m.is_backgrounded} "${(m.description ?? '').slice(0, 60)}"`);
      else if (m.subtype === 'task_progress') note('task_progress', `${m.last_tool_name ?? ''} ${m.summary ?? ''}`.trim());
      else if (m.subtype === 'task_notification') note('task_notification', `${m.status} "${(m.summary ?? '').slice(0, 80)}"`);
      else if (m.subtype === 'background_tasks_changed') note('background_tasks_changed', `${(m.tasks ?? []).length} live`);
      else if (m.subtype === 'session_state_changed') note('session_state_changed', m.state);
    } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text.trim()) { note('assistant', JSON.stringify(c.text.slice(0, 110))); if (turnsEnded >= 1) wokeByItself = true; }
        if (c.type === 'tool_use') note('assistant tool_use', `${c.name} ${JSON.stringify(c.input).slice(0, 80)}`);
      }
    } else if (m.type === 'result') { turnsEnded++; note('result (turn ended)', m.subtype); }
  }
})().catch((e) => note('error', e.message));

inbox.push({ type: 'user', message: { role: 'user', content: 'Please have a worker run this in the current folder: sleep 12; echo finished > result.txt . Then tell me what it wrote.' }, parent_tool_use_id: null });
note('prompt sent');

// Wait for the first turn to end, then watch an idle session for up to 90 s without sending anything.
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  if (turnsEnded >= 2) break;
  if (turnsEnded >= 1 && log.some((l) => l.kind === 'task_notification') && Date.now() - t0 > 60_000 && !wokeByItself) {
    // The worker has finished and a quiet period has passed; give it a little longer then stop waiting.
    if (Date.now() - t0 > 100_000) break;
  }
}
console.log('\n--- summary ---');
const first = log.find((l) => l.kind === 'result (turn ended)');
const started = log.find((l) => l.kind === 'task_started');
const done = log.find((l) => l.kind === 'task_notification');
console.log(`first turn ended after  ${first ? first.at.toFixed(1) + 's' : 'never'}`);
console.log(`worker started at       ${started ? started.at.toFixed(1) + 's' : 'never'}`);
console.log(`worker finished at      ${done ? done.at.toFixed(1) + 's' : 'never'}`);
console.log(`main session woke by itself after the worker finished: ${wokeByItself ? 'YES' : 'no'}`);
console.log(`result file: ${fs.existsSync(path.join(dir, 'result.txt')) ? JSON.stringify(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8').trim()) : 'missing'}`);
inbox.close();
try { q.close(); } catch { /* done */ }
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
