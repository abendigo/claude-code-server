// A manual check against the REAL Agent SDK and your Claude login (not part of `node --test`).
// Costs a few cents. Run: node agent/test/real-workers.smoke.mjs
// Starts a throwaway service, asks Claude to have a worker run a slow command, and checks:
// the main session answers at once and is free, the service reports the worker (and stays busy),
// and the idle session wakes by itself with the result. Then a second job is stopped with stop_task.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const SERVICE = new URL('../service.mjs', import.meta.url).pathname;
// Under the home folder: the service only lets sessions work inside it.
const dir = fs.mkdtempSync(path.join(process.env.HOME || os.homedir(), '.rw-smoke-'));
const env = { ...process.env, AGENT_STATE_DIR: path.join(dir, 'state'), AGENT_SOCKET: path.join(os.tmpdir(), `rw-${process.pid}.sock`), AGENT_SETTING_SOURCES: 'user', AGENT_PERMISSION_MODE: 'bypassPermissions' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
let child;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) process.exitCode = 1; };
const busy = () => spawnSync(process.execPath, [SERVICE, 'busy'], { env }).status === 0;

child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'inherit', 'inherit'] });
while (!fs.existsSync(env.AGENT_SOCKET)) await sleep(50);
await sleep(100);
const sock = net.connect(env.AGENT_SOCKET);
const seen = [];
readline.createInterface({ input: sock }).on('line', (l) => {
  const m = JSON.parse(l);
  seen.push({ ...m, _t: Date.now() });
  if (process.env.DEBUG_SDK && m.type === 'sdk' && m.message.type === 'system' && m.message.subtype !== 'init') console.log(`${at()}  [sdk system] ${m.message.subtype} ${JSON.stringify({ id: m.message.task_id, type: m.message.task_type, bg: m.message.is_backgrounded, status: m.message.status, reason: m.message.reason, summary: String(m.message.summary ?? '').slice(0, 90), desc: String(m.message.description ?? '').slice(0, 40), tasks: m.message.tasks?.map((t) => `${t.type}:${t.status}`) })}`);
  if (m.type === 'tasks') console.log(`${at()}  tasks  ${m.tasks.map((t) => `${t.description.slice(0, 40)}:${t.status}`).join(', ')}`);
  else if (m.type === 'session_state') console.log(`${at()}  session_state ${m.state}`);
  else if (m.type === 'sdk' && m.message.type === 'assistant' && !m.message.parent_tool_use_id) for (const c of m.message.content ?? m.message.message?.content ?? []) if (c.type === 'text') console.log(`${at()}  assistant  ${JSON.stringify(c.text.slice(0, 100))}`);
});
const send = (m) => sock.write(JSON.stringify(m) + '\n');
const until = async (pred, ms = 120_000) => { const t = Date.now(); for (;;) { const m = seen.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error('timed out; saw ' + [...new Set(seen.map((x) => x.type))].join(',')); await sleep(100); } };
const results = () => seen.filter((m) => m.type === 'sdk' && m.message.type === 'result').length;

try {
  send({ type: 'attach', cwd: dir });
  await until((m) => m.type === 'attached');
  send({ type: 'prompt', text: 'Please have a worker run this in the current folder: sleep 15; echo finished > result.txt . Then tell me what it wrote.' });
  const started = await until((m) => m.type === 'tasks' && m.tasks.some((t) => t.status === 'running'));
  check('the service reports a running worker', started.tasks.length === 1, JSON.stringify(started.tasks[0]?.description?.slice(0, 50)));
  await until(() => results() >= 1);
  const firstTurnAt = (Date.now() - t0) / 1000;
  check('the main session answered at once (first turn ended quickly)', firstTurnAt < 30, `${firstTurnAt.toFixed(1)}s`);
  await until((m) => m.type === 'session_state' && m.state === 'idle');
  check('the service is busy while the worker runs, though the session is idle', busy());
  await until(() => results() >= 2, 150_000);
  check('the idle session woke by itself and reported', seen.some((m) => m.type === 'session_state' && m.state === 'working' && m._t > started._t + 5000));
  const done = await until((m) => m.type === 'tasks' && m.tasks.length && m.tasks.every((t) => t.status !== 'running'));
  check('the worker shows as finished', done.tasks[0].status === 'completed', done.tasks[0].status);
  check('the result file is there, in the session folder', fs.existsSync(path.join(dir, 'result.txt')) && fs.readFileSync(path.join(dir, 'result.txt'), 'utf8').trim() === 'finished');
  check('exactly one worker is listed (its shell command is not a second one)', done.tasks.length === 1, `${done.tasks.length}`);

  // A second job, stopped on its own.
  const before = seen.length;
  send({ type: 'prompt', text: 'Please have a worker run this in the current folder and wait for it: sleep 100; echo second > second.txt . Then tell me what it wrote.' });
  const second = await until((m) => seen.indexOf(m) >= before && m.type === 'tasks' && m.tasks.some((t) => t.status === 'running'));
  const id = second.tasks.find((t) => t.status === 'running').id;
  await until(() => results() >= 3);
  send({ type: 'stop_task', task: id });
  const stopped = await until((m) => seen.indexOf(m) >= before && m.type === 'tasks' && m.tasks.find((t) => t.id === id)?.status === 'stopped', 60_000);
  check('stop_task stops that worker', stopped.tasks.find((t) => t.id === id).status === 'stopped', stopped.tasks.find((t) => t.id === id).status);
  await until((m) => seen.indexOf(m) >= before && m.type === 'session_state' && m.state === 'idle' && seen.filter((x) => x.type === 'session_state').pop() === m, 90_000);
  await sleep(500);
  check('and nothing is left running', !busy());
  check('the stopped job never wrote its file', !fs.existsSync(path.join(dir, 'second.txt')));
} catch (e) {
  check('completed without error', false, e.message);
} finally {
  sock.destroy();
  child.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
