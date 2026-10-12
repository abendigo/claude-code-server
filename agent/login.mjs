// Sign-in relay. When the stored login expires and cannot be refreshed,
// `claude auth login` is the fix. It prints a URL and then waits for the code
// the browser shows, so we run it here and pass the URL and code through to
// the page, instead of someone fishing a wrapped URL out of a terminal. The
// credentials land in ~/.claude, which every later session reads.
import { spawn } from 'node:child_process';

export const AUTH_ERROR = /oauth|authentication[_ ]failed|invalid[_ ]api[_ ]key|please run \/?login|\b401\b|not logged in/i;

// An expired login shows up as an error on an assistant message or a failed result.
export function looksLikeAuthFailure(m) {
  if (m?.type === 'assistant' && m.error === 'authentication_failed') return true;
  if (m?.type === 'result' && m.is_error) return AUTH_ERROR.test(String(m.result ?? ''));
  return false;
}

export class LoginFlow {
  // emit(obj): where login_url / login_result messages go (the viewer that started it).
  constructor({ argv = process.env.AGENT_LOGIN_JSON ? JSON.parse(process.env.AGENT_LOGIN_JSON) : ['claude', 'auth', 'login'] } = {}) {
    this.argv = argv;
    this.child = null;
  }

  start(emit) {
    this.cancel();
    const child = spawn(this.argv[0], this.argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'true' } });
    this.child = child;
    let sawUrl = false;
    let tail = '';
    const onData = (buf) => {
      tail = (tail + buf).slice(-4000);
      if (sawUrl) return;
      const m = tail.match(/https:\/\/\S+/);
      if (!m) return;
      sawUrl = true;
      emit({ type: 'login_url', url: m[0] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      if (this.child === child) { this.child = null; emit({ type: 'login_result', ok: false, message: `could not run sign-in: ${e.message}` }); }
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      const ok = code === 0;
      emit({ type: 'login_result', ok, ...(ok ? {} : { message: tail.trim().split('\n').pop() || `sign-in failed (exit ${code})` }) });
    });
  }

  code(text) {
    if (this.child && typeof text === 'string' && text.trim()) this.child.stdin.write(text.trim() + '\n');
  }

  cancel() {
    const child = this.child;
    this.child = null;
    if (child) child.kill('SIGTERM');
  }
}
