// Minimal client for ttyd's websocket protocol (what its own web UI speaks).
//   client -> server: first frame is JSON {AuthToken, columns, rows}; after
//     that, '0'+text is input and '1'+JSON{columns,rows} is a resize.
//   server -> client: first byte is the type: '0' output, '1' title, '2' prefs.
// Frames are binary. The gateway's -H Remote-User auth rides on the session
// cookie, so there is nothing to authenticate here.
const enc = new TextEncoder();

export class TtydConnection {
  constructor(url, { onOutput, onStatus }) {
    this.url = new URL(url, location.href);
    this.url.protocol = this.url.protocol.replace('http', 'ws');
    this.onOutput = onOutput;
    this.onStatus = onStatus;
    this.ws = null;
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  connect(cols, rows) {
    this.close();
    this.onStatus('connecting');
    const ws = new WebSocket(this.url, ['tty']);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      ws.send(enc.encode(JSON.stringify({ AuthToken: '', columns: cols, rows })));
      this.onStatus('connected');
    };
    ws.onmessage = (ev) => {
      const bytes = typeof ev.data === 'string' ? enc.encode(ev.data) : new Uint8Array(ev.data);
      if (String.fromCharCode(bytes[0]) === '0') this.onOutput(bytes.subarray(1));
    };
    ws.onclose = () => { if (this.ws === ws) this.onStatus('disconnected'); };
    ws.onerror = () => {};
  }

  send(text) {
    if (this.open) this.ws.send(enc.encode('0' + text));
  }

  resize(cols, rows) {
    if (this.open) this.ws.send(enc.encode('1' + JSON.stringify({ columns: cols, rows })));
  }

  close() {
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
  }
}
