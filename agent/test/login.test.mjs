// The bridge's sign-in relay, run for real against a fake `claude auth login`
// (prints a URL, waits for a code on stdin, succeeds only for the right one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const BRIDGE = new URL('../bridge.mjs', import.meta.url).pathname;
const FAKE = `
console.log('Opening browser to sign in...');
console.log('If the browser did not open, visit: https://example.test/oauth/authorize?code=true&state=abc');
process.stdout.write('Paste code here if prompted > ');
process.stdin.once('data', (d) => { if (String(d).trim() === 'good-code') process.exit(0); console.error('Invalid code'); process.exit(1); });
`;

function bridge() {
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, AGENT_LOGIN_JSON: JSON.stringify([process.execPath, '-e', FAKE]) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    lines.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (type) => {
    for (;;) {
      const i = lines.findIndex((m) => m.type === type);
      if (i >= 0) return lines.splice(i, 1)[0];
      await new Promise((r) => waiters.push(r));
    }
  };
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  return { next, send, stop: () => child.kill() };
}

test('login_start surfaces the URL, and the right code finishes the sign-in', async () => {
  const b = bridge();
  try {
    b.send({ type: 'login_start' });
    assert.deepEqual(await b.next('login_url'), { type: 'login_url', url: 'https://example.test/oauth/authorize?code=true&state=abc' });
    b.send({ type: 'login_code', code: '  good-code  ' });
    assert.deepEqual(await b.next('login_result'), { type: 'login_result', ok: true });
  } finally { b.stop(); }
});

test('a wrong code reports failure with the reason, and can be retried', async () => {
  const b = bridge();
  try {
    b.send({ type: 'login_start' });
    await b.next('login_url');
    b.send({ type: 'login_code', code: 'nope' });
    const r = await b.next('login_result');
    assert.equal(r.ok, false);
    assert.match(r.message, /Invalid code/);
    b.send({ type: 'login_start' });
    await b.next('login_url');
    b.send({ type: 'login_code', code: 'good-code' });
    assert.equal((await b.next('login_result')).ok, true);
  } finally { b.stop(); }
});
