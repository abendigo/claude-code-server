import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginFlow } from '../client/js/login.js';
import { Conversation } from '../client/js/conversation.js';

function flow() {
  const sent = [];
  const states = [];
  let signedIn = 0;
  const f = new LoginFlow({ send: (m) => { sent.push(m); return true; }, onChange: (x) => states.push(x.state), onSignedIn: () => { signedIn++; } });
  return { f, sent, states, signedIn: () => signedIn };
}

test('expired login opens the dialog; start, url, code, success', () => {
  const { f, sent, states, signedIn } = flow();
  f.handle({ type: 'auth_required' });
  assert.equal(f.state, 'failed');
  f.start();
  assert.deepEqual(sent, [{ type: 'login_start' }]);
  f.handle({ type: 'login_url', url: 'https://x.test/a' });
  assert.equal(f.state, 'url');
  assert.equal(f.url, 'https://x.test/a');
  assert.equal(f.submit('   '), false); // empty code is not sent
  assert.equal(f.submit(' abc '), true);
  assert.deepEqual(sent.at(-1), { type: 'login_code', code: 'abc' });
  assert.equal(f.state, 'checking');
  f.handle({ type: 'login_result', ok: true });
  assert.equal(f.state, 'done');
  assert.equal(signedIn(), 1);
  assert.deepEqual(states, ['failed', 'starting', 'url', 'checking', 'done']);
});

test('a failed sign-in shows why, and cancelling tells the bridge', () => {
  const { f, sent } = flow();
  f.start();
  f.handle({ type: 'login_url', url: 'https://x.test/a' });
  f.submit('bad');
  f.handle({ type: 'login_result', ok: false, message: 'Invalid code' });
  assert.equal(f.state, 'failed');
  assert.equal(f.message, 'Invalid code');
  f.start();
  f.cancel();
  assert.equal(f.state, 'closed');
  assert.deepEqual(sent.at(-1), { type: 'login_cancel' });
});

test('the conversation forwards sign-in messages and explains the expiry in VR', () => {
  const got = [];
  const c = new Conversation({ onAuth: (m) => got.push(m.type) });
  c.handle({ type: 'auth_required' });
  c.handle({ type: 'login_url', url: 'https://x.test/a' });
  c.handle({ type: 'login_result', ok: true });
  assert.deepEqual(got, ['auth_required', 'login_url', 'login_result']);
  assert.match(c.blocks.at(-1).text, /sign-in has expired/);
});
