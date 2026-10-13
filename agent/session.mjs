// One Claude session as the service sees it: the SDK process, its history, the
// approvals waiting on a person, and whoever is currently watching. Viewers come
// and go (headset off, page reload); the session carries on without them.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeAuthFailure, AUTH_ERROR } from './login.mjs';

// A queue the SDK can iterate as streaming input, so one process serves many turns.
export class Inbox {
  constructor() { this.items = []; this.waiter = null; this.closed = false; }
  push(item) {
    if (this.waiter) { this.waiter({ value: item, done: false }); this.waiter = null; } else this.items.push(item);
  }
  close() { this.closed = true; this.waiter?.({ value: undefined, done: true }); this.waiter = null; }
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

// Only allow working directories inside the user's home (/workspace).
export function safeCwd(home, requested) {
  const dir = path.resolve(requested || home);
  const ok = (dir === home || dir.startsWith(home + path.sep)) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  return ok ? dir : home;
}

// Past messages from the SDK's transcript, in the shape the page already
// understands. Subagent internals are left out, as they are live.
export function historyEntries(messages) {
  return (messages ?? [])
    .filter((m) => (m.type === 'user' || m.type === 'assistant') && !m.parent_tool_use_id)
    .map((m) => ({ type: 'sdk', message: { type: m.type, uuid: m.uuid, session_id: m.session_id, parent_tool_use_id: null, message: m.message } }));
}

const MAX_LOG = 5000;

export class Session {
  // sdk: {query, getSessionMessages}; env: {home, autoAllow, settingSources, systemPromptAppend, permissionMode}
  constructor({ sdk, env, cwd, resume, now = Date.now, log = () => {}, onEnd = () => {}, onState = () => {} }) {
    this.id = randomUUID().slice(0, 8); // the service's own handle; the SDK's id only exists after the first message
    this.sdk = sdk;
    this.env = env;
    this.cwd = safeCwd(env.home, cwd);
    this.sdkId = resume || null;
    this.now = now;
    this.logFn = log;
    this.onEnd = onEnd;
    this.onState = onState;
    this.state = 'idle'; // idle | working | waiting | closed
    this.viewers = new Set(); // objects with send(obj)
    this.history = []; // everything a newcomer needs to catch up: {type:'sdk', message, at?} and {type:'user_prompt', text, at}
    this.pending = new Map(); // permission id -> {resolve, input, suggestions, request}
    this.query = null;
    this.inbox = null;
    this.firstPrompt = '';
    this.lastActivity = now();
    this.authFailed = false;
    this.tasks = new Map(); // background workers: task id -> {id, description, status, startedAt, endedAt, last, summary}
    this.legacy = false; // made by a page that never asked to attach: ends with its page, as the old bridge did
    // A resumed session starts from its transcript; attach waits for this.
    this.ready = resume ? this.loadTranscript() : Promise.resolve();
  }

  async loadTranscript() {
    try {
      const msgs = await this.sdk.getSessionMessages(this.sdkId, { dir: this.cwd });
      this.history = historyEntries(msgs);
      const first = this.history.find((e) => e.message.type === 'user' && typeof e.message.message?.content === 'string');
      if (first) this.firstPrompt = first.message.message.content;
    } catch (e) {
      this.logFn('could not read the transcript', this.sdkId, e.message);
    }
  }

  get live() { return Boolean(this.query); }
  get running() { return [...this.tasks.values()].filter((t) => t.status === 'running'); }

  // Working, waiting for an answer, or with a background worker still going: not safe to stop the container.
  get busy() { return this.state === 'working' || this.state === 'waiting' || this.running.length > 0; }

  info() {
    return { id: this.id, sdkId: this.sdkId, cwd: this.cwd, state: this.state, live: this.live, firstPrompt: this.firstPrompt, lastActivity: this.lastActivity, viewers: this.viewers.size, workers: this.running.length };
  }

  // ---- viewers ---------------------------------------------------------------
  broadcast(obj, except = null) {
    for (const v of this.viewers) if (v !== except) v.send(obj);
  }

  record(entry) {
    this.history.push(entry);
    if (this.history.length > MAX_LOG) this.history.splice(0, this.history.length - MAX_LOG);
  }

  setState(state) {
    if (this.state === state || this.state === 'closed') return;
    this.state = state;
    this.broadcast({ type: 'session_state', session: this.id, state });
    this.onState(this, state);
  }

  // What a viewer needs when it starts following: the past, then approvals still waiting.
  catchUp(viewer) {
    viewer.send({ type: 'attached', session: this.id, sdkId: this.sdkId, cwd: this.cwd, state: this.state, live: this.live, tasks: this.taskList() });
    viewer.send({ type: 'history', messages: this.history });
    for (const p of this.pending.values()) viewer.send(p.request);
  }

  // ---- input -----------------------------------------------------------------
  prompt(text, from = null) {
    if (this.state === 'closed' || typeof text !== 'string' || !text.trim()) return false;
    if (!this.query) this.start();
    if (!this.firstPrompt) this.firstPrompt = text.trim();
    const at = this.now();
    this.lastActivity = at;
    this.record({ type: 'user_prompt', text, at });
    this.broadcast({ type: 'user_prompt', text, at }, from); // the sender already shows it
    this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.setState('working');
    return true;
  }

  answer(id, allow, always) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (allow) {
      // "Always": apply the SDK's own suggested rule so it isn't asked again.
      p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: always ? p.suggestions : undefined });
    } else {
      p.resolve({ behavior: 'deny', message: 'The user denied this action.' });
    }
    this.broadcast({ type: 'permission_cancelled', id }); // someone answered; other viewers drop their card
    if (!this.pending.size) this.setState('working');
    return true;
  }

  interrupt() {
    this.query?.interrupt().catch((e) => this.logFn('interrupt failed', e.message));
  }

  canUseTool = (tool, input, opts) => {
    if (this.env.autoAllow.includes(tool)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = randomUUID();
      const request = { type: 'permission_request', id, tool, input, title: opts.title, displayName: opts.displayName, description: opts.description };
      this.pending.set(id, { resolve, input, suggestions: opts.suggestions, request });
      this.setState('waiting');
      this.broadcast(request);
      opts.signal?.addEventListener('abort', () => {
        if (this.pending.delete(id)) {
          this.broadcast({ type: 'permission_cancelled', id });
          resolve({ behavior: 'deny', message: 'Cancelled' });
          if (!this.pending.size) this.setState('working');
        }
      });
    });
  };

  // ---- the SDK process -------------------------------------------------------
  start() {
    this.inbox = new Inbox();
    this.authFailed = false;
    const query = this.sdk.query({
      prompt: this.inbox,
      options: {
        cwd: this.cwd,
        resume: this.sdkId || undefined,
        includePartialMessages: true,
        // Behave like the terminal: honour the user's CLAUDE.md and settings.
        settingSources: this.env.settingSources,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(this.env.systemPromptAppend ? { append: this.env.systemPromptAppend } : {}) },
        permissionMode: this.env.permissionMode,
        // Background workers: Stop ends the turn only, a worker is stopped on its own (stopTask).
        perTaskStopAffordance: true,
        ...(this.env.workers ? { agents: { worker: this.env.workers } } : {}),
        ...(this.env.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool: this.canUseTool,
        stderr: (s) => this.logFn(s.trimEnd()),
      },
    });
    this.query = query;
    this.pump(query);
  }

  async pump(query) {
    try {
      for await (const message of query) {
        if (this.query !== query) return; // stopped or replaced
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) this.sdkId = message.session_id;
        this.lastActivity = this.now();
        // A finished worker wakes an idle session by itself: when it starts answering, it is working.
        // (A worker's own messages carry parent_tool_use_id and say nothing about the main session.)
        if (this.state === 'idle' && !message.parent_tool_use_id && (message.type === 'assistant' || message.type === 'stream_event' || (message.type === 'system' && message.subtype === 'init'))) this.setState('working');
        if (message.type === 'system') this.trackTask(message);
        const wrapped = { type: 'sdk', message };
        this.broadcast(wrapped);
        if (message.type !== 'stream_event') this.record({ ...wrapped, at: this.lastActivity });
        if (message.type === 'result') this.setState(this.pending.size ? 'waiting' : 'idle');
        if (looksLikeAuthFailure(message)) { this.authFailed = true; this.broadcast({ type: 'auth_required' }); }
      }
    } catch (e) {
      if (this.query !== query) return;
      this.broadcast({ type: 'error', message: e.message });
      if (AUTH_ERROR.test(e.message)) { this.authFailed = true; this.broadcast({ type: 'auth_required' }); }
    }
    if (this.query !== query) return;
    this.query = null;
    this.inbox = null;
    // After a failed sign-in the session stays: the next prompt starts it again, resuming where it was.
    if (this.authFailed) { this.cancelPending(); this.setState('idle'); return; }
    this.end();
  }

  // ---- background workers ------------------------------------------------------
  // The SDK reports a worker starting, progressing and finishing, plus the live set
  // whenever it changes; the live set is the authority, so a missed message cannot
  // leave a worker showing as running forever. Only subagents count as workers: the
  // shell commands a worker runs show up as tasks too, and a dev server left running
  // in the background must not keep the container from ever being stopped.
  trackTask(m) {
    const now = this.now();
    let changed = false;
    if (m.subtype === 'task_started' && m.is_backgrounded && m.task_type === 'local_agent' && !m.skip_transcript) {
      this.tasks.set(m.task_id, { id: m.task_id, description: m.description ?? '', kind: m.task_type ?? '', status: 'running', startedAt: now, endedAt: null, last: '', summary: '' });
      changed = true;
    } else if (m.subtype === 'task_progress') {
      const t = this.tasks.get(m.task_id);
      if (t) { t.last = m.summary || m.last_tool_name || t.last; changed = true; }
    } else if (m.subtype === 'task_notification' && !m.ambient) {
      const t = this.tasks.get(m.task_id);
      // The live set can arrive before the notification, and only guesses "completed": the notification has the truth.
      if (t && (t.status === 'running' || t.guessed)) { t.status = m.status; t.endedAt = now; t.summary = m.summary ?? ''; t.guessed = false; changed = true; }
    } else if (m.subtype === 'background_tasks_changed') {
      const live = new Map((m.tasks ?? []).filter((t) => t.type === 'subagent').map((t) => [t.id, t]));
      for (const t of this.tasks.values()) if (t.status === 'running' && !live.has(t.id)) { t.status = 'completed'; t.guessed = true; t.endedAt = now; changed = true; }
      for (const [id, t] of live) if (!this.tasks.has(id)) { this.tasks.set(id, { id, description: t.description ?? '', kind: t.type ?? '', status: 'running', startedAt: now, endedAt: null, last: '', summary: '' }); changed = true; }
    }
    if (changed) this.sendTasks();
  }

  // Running first, then the last few that finished.
  taskList() {
    const all = [...this.tasks.values()];
    const done = all.filter((t) => t.status !== 'running').sort((a, b) => b.endedAt - a.endedAt).slice(0, 5);
    return [...all.filter((t) => t.status === 'running').sort((a, b) => a.startedAt - b.startedAt), ...done];
  }

  sendTasks() {
    this.broadcast({ type: 'tasks', session: this.id, tasks: this.taskList() });
    this.onState(this, this.state); // the idle-stop and the legacy rule look at busy, which just changed
  }

  stopTask(id) {
    if (this.tasks.get(id)?.status !== 'running') return false;
    this.query?.stopTask(id).catch((e) => this.logFn('stopTask failed', e.message));
    return true;
  }

  cancelPending() {
    for (const [id, p] of this.pending) { p.resolve({ behavior: 'deny', message: 'Cancelled' }); this.broadcast({ type: 'permission_cancelled', id }); }
    this.pending.clear();
  }

  // Shut the SDK process down but keep the session: it resumes from its transcript on the next prompt.
  stop() {
    const query = this.query;
    this.query = null;
    this.cancelPending();
    for (const t of this.tasks.values()) if (t.status === 'running') { t.status = 'stopped'; t.endedAt = this.now(); }
    this.inbox?.close();
    this.inbox = null;
    try { query?.close(); } catch { /* already gone */ }
    if (this.state !== 'closed') this.setState('idle');
  }

  // End for good.
  close() {
    this.stop();
    this.end();
  }

  end() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.broadcast({ type: 'closed', session: this.id });
    this.onEnd(this);
  }
}
