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
//   bridge -> client
//     {type:'sdk', message}                   a raw SDK message (system/assistant/user/stream_event/result)
//     {type:'permission_request', id, tool, input, title?, displayName?, description?}
//     {type:'permission_cancelled', id}
//     {type:'error', message}
//     {type:'closed'}
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HOME = process.env.HOME || '/workspace';
// Tools that never need asking about. Everything else goes to the user.
const AUTO_ALLOW = (process.env.AGENT_AUTO_ALLOW || 'Read,Glob,Grep,TodoWrite').split(',').filter(Boolean);
// Which Claude settings files apply. Default matches the terminal; a user's own
// allow rules / auto mode in them can approve tools before we are ever asked.
const SETTING_SOURCES = (process.env.AGENT_SETTING_SOURCES ?? 'user,project,local').split(',').filter(Boolean);

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

function startSession({ cwd, resume }) {
  session = query({
    prompt: inbox,
    options: {
      cwd: safeCwd(cwd),
      resume: resume || undefined,
      includePartialMessages: true,
      // Behave like the terminal: honour the user's CLAUDE.md and settings.
      settingSources: SETTING_SOURCES,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default',
      canUseTool,
      stderr: (s) => log(s.trimEnd()),
    },
  });
  (async () => {
    try {
      for await (const message of session) out({ type: 'sdk', message });
    } catch (e) {
      out({ type: 'error', message: e.message });
    }
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
}).on('close', () => { session?.close(); inbox.close(); process.exit(0); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { session?.close(); process.exit(0); });
