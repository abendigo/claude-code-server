// Websocket to the gateway's agent endpoint; feeds a Conversation. Each
// connection is one Claude Code session (the bridge process is created lazily
// on the first prompt), so "new conversation" means "new connection".
export class AgentClient {
  constructor(url, convo) {
    this.url = new URL(url, location.href);
    this.url.protocol = this.url.protocol.replace('http', 'ws');
    this.convo = convo;
    this.ws = null;
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  connect() {
    this.close();
    this.convo.reset();
    this.convo.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) this.convo.setState('idle'); };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try { this.convo.handle(JSON.parse(ev.data)); } catch (e) { console.error('bad agent message', e); }
    };
    ws.onclose = () => { if (this.ws === ws) this.convo.handle({ type: 'exit' }); };
    ws.onerror = () => { if (this.ws === ws) this.convo.notice('Could not reach the agent service.', 'error'); };
  }

  send(obj) {
    if (!obj) return false;
    if (!this.open) { this.convo.notice('Not connected. Press New to reconnect.', 'error'); return false; }
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close() {
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
  }
}
