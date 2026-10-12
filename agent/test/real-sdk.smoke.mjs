// A manual check against the REAL Agent SDK and your Claude login (not part of `node --test`,
// which only picks up *.test.mjs). Costs a few tokens.
//   node agent/test/real-sdk.smoke.mjs
// Starts a throwaway service in a temp state dir, asks one trivial question, detaches, restarts
// the service, and checks the session can be listed, replayed and resumed.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const SERVICE = new URL('../service.mjs', import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-'));
const env = { ...process.env, AGENT_STATE_DIR: path.join(dir, 'state'), AGENT_SOCKET: path.join(dir, 's.sock'), AGENT_SETTING_SOURCES: 'user' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child;
const start = async () => {
  child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i++) { if (fs.existsSync(env.AGENT_SOCKET)) { await sleep(100); return; } await sleep(50); }
  throw new Error('service did not start');
};
const viewer = () => new Promise((resolve) => {
  const sock = net.connect(env.AGENT_SOCKET); const seen = [];
  readline.createInterface({ input: sock }).on('line', (l) => seen.push(JSON.parse(l)));
  const v = { seen, send: (m) => sock.write(JSON.stringify(m) + '\n'), close: () => sock.destroy(),
    async until(pred, ms = 90_000) { const t = Date.now(); for (;;) { const m = seen.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error('timed out; saw ' + seen.map((x) => x.type).join(',')); await sleep(100); } } };
  sock.once('connect', () => resolve(v));
});
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) process.exitCode = 1; };
const assistantText = (m) => m.type === 'sdk' && m.message.type === 'assistant' && m.message.message.content.find((c) => c.type === 'text')?.text;

try {
  await start();
  const a = await viewer();
  a.send({ type: 'attach', cwd: dir });
  const at = await a.until((m) => m.type === 'attached');
  a.send({ type: 'prompt', text: 'Reply with the single word pong and nothing else.' });
  await a.until((m) => m.type === 'sdk' && m.message.type === 'result');
  const said = a.seen.map(assistantText).filter(Boolean).join(' ');
  check('the real SDK answered through the service', /pong/i.test(said), JSON.stringify(said.slice(0, 80)));
  const init = a.seen.find((m) => m.type === 'sdk' && m.message.subtype === 'init');
  check('init message carries a session id', Boolean(init?.message.session_id));
  a.close();

  child.kill('SIGTERM'); await sleep(500); await start(); // service restart: only the transcript remains
  const b = await viewer();
  b.send({ type: 'list_sessions' });
  const list = (await b.until((m) => m.type === 'sessions')).list;
  const row = list.find((r) => r.sdkId === init.message.session_id);
  check('the session is listed after a restart', Boolean(row), row ? JSON.stringify(row.summary).slice(0, 60) : '');
  b.send({ type: 'attach', sdkId: init.message.session_id, cwd: dir });
  const hist = await b.until((m) => m.type === 'history');
  const kinds = hist.messages.map((e) => (e.type === 'sdk' ? e.message.type : e.type));
  check('history replays the transcript (user then assistant)', kinds.includes('user') && kinds.includes('assistant'), kinds.join(','));
  check('history keeps no subagent internals or stream events', hist.messages.every((e) => e.message?.type !== 'stream_event'));
  b.send({ type: 'prompt', text: 'What single word did I ask you to reply with? One word.' });
  await b.until((m) => m.type === 'sdk' && m.message.type === 'result');
  const again = b.seen.map(assistantText).filter(Boolean).join(' ');
  check('the resumed session remembers', /pong/i.test(again), JSON.stringify(again.slice(0, 80)));
} finally {
  child?.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
