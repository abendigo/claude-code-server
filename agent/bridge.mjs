#!/usr/bin/env node
// agent-bridge: one Claude Code session, controlled over stdio. The gateway
// runs this inside a user's worker (`docker exec -i`) and relays it to the
// VR client over a websocket. stdout carries ONLY protocol lines (JSON); any
// logging goes to stderr.
//
//   client -> bridge
//     {type:'prompt', text, cwd?, resume?}   send a user message (starts the session on first use)
//     {type:'permission', id, allow, always?} answer a permission_request
//     {type:'interrupt'}                      stop the current turn
//     {type:'login_start'} / {type:'login_code', code} / {type:'login_cancel'}
//                                             sign in again (see "Sign-in" below)
//   bridge -> client
//     {type:'sdk', message}                   a raw SDK message (system/assistant/user/stream_event/result)
//     {type:'permission_request', id, tool, input, title?, displayName?, description?}
//     {type:'permission_cancelled', id}
//     {type:'error', message}
//     {type:'auth_required'}                  the login has expired: offer to sign in
//     {type:'login_url', url}                 open this, then send back the code it shows
//     {type:'login_result', ok, message?}     the sign-in finished
//     {type:'closed'}
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const HOME = process.env.HOME || '/workspace';
// Tools that never need asking about. Everything else goes to the user.
const AUTO_ALLOW = (process.env.AGENT_AUTO_ALLOW || 'Read,Glob,Grep,TodoWrite').split(',').filter(Boolean);
// Which Claude settings files apply. Default matches the terminal; a user's own
// allow rules / auto mode in them can approve tools before we are ever asked.
const SETTING_SOURCES = (process.env.AGENT_SETTING_SOURCES ?? 'user,project,local').split(',').filter(Boolean);

// The user may be in a headset and hears a short spoken version of each reply
// (the VR client strips this tag from the text it shows). AGENT_SPOKEN=0 turns it off.
const SPOKEN_PROMPT = process.env.AGENT_SPOKEN === '0' ? '' : [
  'The user is often working by voice and hears a short spoken version of your replies.',
  'At the very end of the final message of each turn, add one or two plain sentences wrapped as <spoken>...</spoken>:',
  'what you did or found, and any question you need answered. Write it as you would say it out loud:',
  'no code, file paths, URLs, symbols or markdown inside it, and do not mention the tag itself.',
].join(' ');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (...a) => console.error('[agent-bridge]', ...a);

// A queue the SDK can iterate as streaming input, so one process serves many turns.
class Inbox {
  constructor() { this.items = []; this.waiter = null; this.closed = false; }
  push(item) {
    if (this.waiter) { this.waiter({ value: item, done: false }); this.waiter = null; } else this.items.push(item);
  }
  close() { this.closed = true; this.waiter?.({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
    };
  }
}

const inbox = new Inbox();
const pending = new Map(); // permission id -> {resolve, input, suggestions}
let session = null;

// Only allow working directories inside the user's home (/workspace).
function safeCwd(requested) {
  const dir = path.resolve(requested || HOME);
  const ok = (dir === HOME || dir.startsWith(HOME + path.sep)) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  return ok ? dir : HOME;
}

function canUseTool(tool, input, opts) {
  if (AUTO_ALLOW.includes(tool)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
  return new Promise((resolve) => {
    const id = randomUUID();
    pending.set(id, { resolve, input, suggestions: opts.suggestions });
    out({
      type: 'permission_request', id, tool, input,
      title: opts.title, displayName: opts.displayName, description: opts.description,
    });
    opts.signal?.addEventListener('abort', () => {
      if (pending.delete(id)) { out({ type: 'permission_cancelled', id }); resolve({ behavior: 'deny', message: 'Cancelled' }); }
    });
  });
}

// ---- Sign-in ----------------------------------------------------------------
// When the stored login expires and cannot be refreshed, `claude auth login`
// is the fix. It prints a URL and then waits for the code the browser shows,
// so we run it here and pass the URL and code through to the page, instead of
// someone fishing a wrapped URL out of a terminal. The credentials land in
// ~/.claude, which every later session reads.
const LOGIN_ARGV = process.env.AGENT_LOGIN_JSON ? JSON.parse(process.env.AGENT_LOGIN_JSON) : ['claude', 'auth', 'login'];
const AUTH_ERROR = /oauth|authentication[_ ]failed|invalid[_ ]api[_ ]key|please run \/?login|\b401\b|not logged in/i;
let login = null;

function startLogin() {
  cancelLogin();
  const child = spawn(LOGIN_ARGV[0], LOGIN_ARGV.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'true' } });
  login = child;
  let sawUrl = false;
  let tail = '';
  const onData = (buf) => {
    tail = (tail + buf).slice(-4000);
    if (sawUrl) return;
    const m = tail.match(/https:\/\/\S+/);
    if (!m) return;
    sawUrl = true;
    out({ type: 'login_url', url: m[0] });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => { if (login === child) { login = null; out({ type: 'login_result', ok: false, message: `could not run sign-in: ${e.message}` }); } });
  child.on('exit', (code) => {
    if (login !== child) return;
    login = null;
    const ok = code === 0;
    out({ type: 'login_result', ok, ...(ok ? {} : { message: tail.trim().split('\n').pop() || `sign-in failed (exit ${code})` }) });
  });
}

function cancelLogin() {
  const child = login;
  login = null;
  if (child) child.kill('SIGTERM');
}

// An expired login shows up as an error on an assistant message or a failed result.
function looksLikeAuthFailure(m) {
  if (m?.type === 'assistant' && m.error === 'authentication_failed') return true;
  if (m?.type === 'result' && m.is_error) return AUTH_ERROR.test(String(m.result ?? ''));
  return false;
}

function startSession({ cwd, resume }) {
  session = query({
    prompt: inbox,
    options: {
      cwd: safeCwd(cwd),
      resume: resume || undefined,
      includePartialMessages: true,
      // Behave like the terminal: honour the user's CLAUDE.md and settings.
      settingSources: SETTING_SOURCES,
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(SPOKEN_PROMPT ? { append: SPOKEN_PROMPT } : {}) },
      permissionMode: 'default',
      canUseTool,
      stderr: (s) => log(s.trimEnd()),
    },
  });
  (async () => {
    let authFailed = false;
    try {
      for await (const message of session) {
        out({ type: 'sdk', message });
        if (looksLikeAuthFailure(message)) { authFailed = true; out({ type: 'auth_required' }); }
      }
    } catch (e) {
      out({ type: 'error', message: e.message });
      if (AUTH_ERROR.test(e.message)) { authFailed = true; out({ type: 'auth_required' }); }
    }
    // After an auth failure stay up: this connection is where the sign-in runs.
    if (authFailed) return;
    out({ type: 'closed' });
    process.exit(0);
  })();
}

function handle(msg) {
  switch (msg.type) {
    case 'prompt':
      if (typeof msg.text !== 'string' || !msg.text.trim()) return;
      if (!session) startSession(msg);
      inbox.push({ type: 'user', message: { role: 'user', content: msg.text }, parent_tool_use_id: null });
      break;
    case 'permission': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.allow) {
        p.resolve({
          behavior: 'allow',
          updatedInput: p.input,
          // "Always": apply the SDK's own suggested rule so it isn't asked again this session.
          updatedPermissions: msg.always ? p.suggestions : undefined,
        });
      } else {
        p.resolve({ behavior: 'deny', message: 'The user denied this action.' });
      }
      break;
    }
    case 'login_start': startLogin(); break;
    case 'login_code':
      if (login && typeof msg.code === 'string' && msg.code.trim()) login.stdin.write(msg.code.trim() + '\n');
      break;
    case 'login_cancel': cancelLogin(); break;
    case 'interrupt':
      session?.interrupt().catch((e) => log('interrupt failed', e.message));
      break;
    default:
      log('ignoring unknown message type', msg.type);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch (e) { out({ type: 'error', message: `bad input: ${e.message}` }); }
}).on('close', () => { cancelLogin(); session?.close(); inbox.close(); process.exit(0); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cancelLogin(); session?.close(); process.exit(0); });
