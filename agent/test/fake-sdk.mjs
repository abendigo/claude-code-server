// A stand-in for @anthropic-ai/claude-agent-sdk, for testing the service without
// a model. Prompts are commands:
//   "hello"           replies "echo: hello"
//   "slow:300 text"   takes 300 ms to reply (the session stays working meanwhile)
//   "ask:rm -rf x"    asks permission for a Bash command first; replies "allowed" or "denied"
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
  let n = 0;
  const gen = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', cwd: options.cwd };
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
      if (options.resume && n === 0) reply += ` (resumed ${options.resume})`;
      n++;
      const assistant = { type: 'assistant', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: reply }] } };
      yield assistant;
      save({ type: 'assistant', uuid: assistant.uuid, session_id: sessionId, message: assistant.message, parent_tool_use_id: null });
      yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 };
    }
  })();
  return Object.assign(gen, {
    interrupt: async () => {},
    close: () => { prompt.close?.(); },
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
