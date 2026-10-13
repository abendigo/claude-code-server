// Websocket to the gateway's agent endpoint; feeds a Conversation.
//
// The sessions live in the worker's session service, not in this page, so the page
// only follows one: on connect it attaches to the last session it was following (or,
// with none remembered, the newest one the service has for this folder, or a new
// one) and the service replays its history. When the connection drops (headset off,
// a gateway deploy, Wi-Fi) it reconnects by itself and attaches to the same session.
//
// A worker that predates the service never answers `attach`; after a moment the
// client falls back to the old behaviour (`legacy`): one session per connection,
// resumed by the first prompt.
const GONE = /no longer there|has ended/i;

export class AgentClient {
  // store: {read() -> {svc, sdk}, write({svc, sdk}), clear()} remembers the session between visits.
  constructor(url, convo, { cwd = '', store = null, attachTimeoutMs = 1500, backoffMs = [1000, 2000, 4000, 8000, 15000] } = {}) {
    this.url = new URL(url, location.href);
    this.url.protocol = this.url.protocol.replace('http', 'ws');
    this.convo = convo;
    this.cwd = cwd;
    this.store = store;
    this.attachTimeoutMs = attachTimeoutMs;
    this.backoffMs = backoffMs;
    this.ws = null;
    this.legacy = false; // an old worker with no session service
    this.attached = false;
    this.tries = []; // attach targets still to try if the current one is gone
    this.wantList = false; // waiting for `sessions` to choose the newest
    this.attempt = 0;
    this.timers = new Set();
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  after(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // to: 'last' (default), 'new', {session} or {sdkId}. keep: leave what is on screen until the service replays it.
  connect({ to = 'last', keep = false } = {}) {
    this.close();
    if (!keep) this.convo.reset();
    this.convo.setState('connecting');
    this.attached = false;
    this.legacy = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.convo.status = '';
      this.convo.setState('idle');
      this.begin(to);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { console.error('bad agent message', e); return; }
      this.intercept(msg);
      try { this.convo.handle(msg); } catch (e) { console.error('bad agent message', e); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.convo.handle({ type: 'exit' });
      this.reconnectSoon();
    };
    ws.onerror = () => {
      if (this.ws === ws && !this.attempt) this.convo.notice('Could not reach the agent service.', 'error');
    };
  }

  // The connection dropped without us asking: try again, to the same session.
  reconnectSoon() {
    const wait = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt++;
    this.convo.status = 'Reconnecting…';
    this.convo.setState('connecting');
    this.after(wait, () => { if (!this.ws) this.connect({ to: 'last', keep: true }); });
  }

  // ---- choosing what to attach to ---------------------------------------------------
  begin(to) {
    if (to === 'new') this.tries = [{}];
    else if (to && typeof to === 'object') this.tries = [to, {}];
    else {
      const { svc, sdk } = this.store?.read() ?? {};
      this.tries = [];
      if (svc) this.tries.push({ session: svc });
      if (sdk) this.tries.push({ sdkId: sdk });
      if (!this.tries.length) { this.wantList = true; this.send({ type: 'list_sessions' }); this.expectAttach(); return; }
      this.tries.push({ recent: true });
    }
    this.next();
  }

  next() {
    const target = this.tries.shift();
    if (!target) return;
    if (target.recent) { this.wantList = true; this.send({ type: 'list_sessions' }); this.expectAttach(); return; }
    this.send({ type: 'attach', ...target, cwd: this.cwd || undefined });
    this.expectAttach();
  }

  // No answer to attach means a worker without the session service.
  expectAttach() {
    this.after(this.attachTimeoutMs, () => {
      if (this.attached || !this.open) return;
      this.legacy = true;
      this.wantList = false;
      this.attempt = 0;
    });
  }

  intercept(msg) {
    if (msg.type === 'attached') {
      this.attached = true;
      this.legacy = false;
      this.attempt = 0; // a real connection: the next drop starts the wait from the beginning
      this.tries = [];
      this.store?.write({ svc: msg.session, sdk: msg.sdkId ?? null });
    } else if (msg.type === 'sessions' && this.wantList) {
      this.wantList = false;
      const here = this.cwd;
      const row = (msg.list ?? []).find((r) => r.state !== 'closed' && (!here || !r.cwd || r.cwd === here || r.cwd.startsWith(here)));
      this.send({ type: 'attach', ...(row ? (row.session ? { session: row.session } : { sdkId: row.sdkId }) : {}), cwd: this.cwd || undefined });
    } else if (msg.type === 'error' && !this.attached && GONE.test(msg.message ?? '')) {
      // The remembered session is gone (the service restarted, or it was closed): try the next best thing.
      this.next();
    }
  }

  // ---- what the panels ask for ---------------------------------------------------------
  switchTo(row) {
    this.send({ type: 'attach', ...(row.session ? { session: row.session } : { sdkId: row.sdkId }), cwd: this.cwd || undefined });
  }

  newSession() {
    this.store?.clear();
    if (this.open && this.attached) this.send({ type: 'attach', cwd: this.cwd || undefined });
    else this.connect({ to: 'new' });
  }

  listSessions() { return this.send({ type: 'list_sessions' }, { quiet: true }); }

  closeSession(session) { return this.send({ type: 'close_session', session }); }

  // Stop one background worker; the session itself carries on.
  stopTask(task) { return this.send({ type: 'stop_task', task }); }

  send(obj, { quiet = false } = {}) {
    if (!obj) return false;
    if (!this.open) {
      if (!quiet) this.convo.notice('Not connected yet. Reconnecting…', 'error');
      return false;
    }
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close() {
    this.clearTimers();
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
  }
}
