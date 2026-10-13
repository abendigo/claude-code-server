// A stand-in for @anthropic-ai/claude-agent-sdk, for testing the service without
// a model. Prompts are commands:
//   "hello"             replies "echo: hello"
//   "slow:300 text"     takes 300 ms to reply (the session stays working meanwhile)
//   "ask:rm -rf x"      asks permission for a Bash command first; replies "allowed" or "denied"
//   "bg:800 name"       hands a job to a background worker, replies "started name" at once; the
//                       worker finishes 800 ms later and the idle session wakes up to say "name finished"
//   "options?"          replies with what the service passed to query()
// Transcripts are written to $FAKE_DIR so they outlive the service, like the real SDK's.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = () => { fs.mkdirSync(process.env.FAKE_DIR, { recursive: true }); return process.env.FAKE_DIR; };
const file = (id) => path.join(dir(), `${id}.json`);
const readTranscript = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function query({ prompt, options }) {
  const sessionId = options.resume || `fake-${randomUUID().slice(0, 8)}`;
  const transcript = readTranscript(sessionId);
  const save = (m) => { transcript.push(m); fs.writeFileSync(file(sessionId), JSON.stringify(transcript)); };

  // Everything the session says goes through one queue, so a worker finishing later can speak between prompts.
  const out = [];
  let waiter = null;
  let ended = false;
  const push = (m) => { if (waiter) { const w = waiter; waiter = null; w({ value: m, done: false }); } else out.push(m); };
  const end = () => { ended = true; waiter?.({ value: undefined, done: true }); waiter = null; };
  const tasks = new Map(); // id -> timer
  let n = 0;

  const say = (text) => {
    n++;
    const assistant = { type: 'assistant', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text }] } };
    push(assistant);
    save({ type: 'assistant', uuid: assistant.uuid, session_id: sessionId, message: assistant.message, parent_tool_use_id: null });
    push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 });
  };
  const live = () => ({ type: 'system', subtype: 'background_tasks_changed', tasks: [...tasks.keys()].map((id) => ({ id, type: 'subagent', status: 'running', description: id })), uuid: randomUUID(), session_id: sessionId });
  const finish = (id, name, status = 'completed') => {
    if (!tasks.has(id)) return;
    clearTimeout(tasks.get(id));
    tasks.delete(id);
    push(live()); // as the real SDK does: the live set first, then the notification
    push({ type: 'system', subtype: 'task_notification', task_id: id, status, output_file: '', summary: `${name} ${status}`, uuid: randomUUID(), session_id: sessionId });
    // The idle session wakes up by itself and reports, whether the worker finished or was stopped.
    push({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', cwd: options.cwd });
    say(status === 'completed' ? `${name} finished` : `${name} was ${status}`);
  };

  (async () => {
    push({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', cwd: options.cwd });
    for await (const m of prompt) {
      const text = String(m.message.content);
      save({ type: 'user', uuid: randomUUID(), session_id: sessionId, message: { role: 'user', content: text }, parent_tool_use_id: null });
      let reply = `echo: ${text}`;
      const slow = /^slow:(\d+)\s*(.*)$/.exec(text);
      if (slow) { await sleep(Number(slow[1])); reply = `echo: ${slow[2]}`; }
      const ask = /^ask:(.*)$/.exec(text);
      if (ask) {
        const r = await options.canUseTool('Bash', { command: ask[1] }, { suggestions: [], displayName: 'Bash', description: 'a test command' });
        reply = r.behavior === 'allow' ? 'allowed' : 'denied';
      }
      const bg = /^bg:(\d+)\s*(.*)$/.exec(text);
      if (bg) {
        const id = `task-${randomUUID().slice(0, 6)}`;
        const name = bg[2] || 'job';
        push({ type: 'system', subtype: 'task_started', task_id: id, description: name, task_type: 'local_agent', is_backgrounded: true, uuid: randomUUID(), session_id: sessionId });
        tasks.set(id, setTimeout(() => finish(id, name), Number(bg[1])));
        push(live());
        push({ type: 'system', subtype: 'task_progress', task_id: id, description: name, last_tool_name: 'Bash', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, uuid: randomUUID(), session_id: sessionId });
        reply = `started ${name}`;
      }
      if (text === 'options?') {
        reply = JSON.stringify({ worker: Boolean(options.agents?.worker), background: options.agents?.worker?.background, stopAffordance: options.perTaskStopAffordance, mentionsWorkers: String(options.systemPrompt?.append ?? '').includes('worker') });
      }
      if (options.resume && n === 0) reply += ` (resumed ${options.resume})`;
      say(reply);
    }
    end();
  })();

  const iterator = {
    [Symbol.asyncIterator]() {
      return { next: () => (out.length ? Promise.resolve({ value: out.shift(), done: false }) : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => { waiter = r; })) };
    },
  };
  return Object.assign(iterator, {
    interrupt: async () => {},
    stopTask: async (id) => { const name = id; finish(id, name, 'stopped'); },
    close: () => { for (const t of tasks.values()) clearTimeout(t); tasks.clear(); prompt.close?.(); end(); },
  });
}

export async function getSessionMessages(id) {
  return readTranscript(id);
}

export async function listSessions() {
  const out = [];
  for (const f of fs.readdirSync(dir())) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    const t = readTranscript(id);
    const first = t.find((m) => m.type === 'user');
    out.push({ sessionId: id, summary: first?.message.content ?? '', firstPrompt: first?.message.content ?? '', lastModified: fs.statSync(path.join(dir(), f)).mtimeMs, cwd: process.env.HOME });
  }
  return out;
}
