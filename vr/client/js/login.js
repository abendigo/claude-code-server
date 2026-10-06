// Signing in again when the Claude login has expired. LoginFlow is the state
// machine (no DOM, so it can be tested); LoginDialog is the page overlay that
// shows it: a link to click, a box for the code the browser then displays.
//
// states: closed | starting | url (waiting for the code) | checking | done | failed
export class LoginFlow {
  constructor({ send, onChange = () => {}, onSignedIn = () => {} }) {
    this.send = send;
    this.onChange = onChange;
    this.onSignedIn = onSignedIn;
    this.state = 'closed';
    this.url = '';
    this.message = '';
  }

  set(state, extra = {}) {
    Object.assign(this, { state, message: '' }, extra);
    this.onChange(this);
  }

  // Messages from the bridge. Returns true if it was one of ours.
  handle(msg) {
    switch (msg.type) {
      case 'auth_required': if (this.state === 'closed' || this.state === 'done') this.set('failed', { message: 'Your Claude sign-in has expired.' }); return true;
      case 'login_url': this.set('url', { url: msg.url }); return true;
      case 'login_result':
        if (msg.ok) { this.set('done'); this.onSignedIn(); } else this.set('failed', { message: msg.message || 'Sign-in did not complete.' });
        return true;
      default: return false;
    }
  }

  start() { this.set('starting'); this.send({ type: 'login_start' }); }

  submit(code) {
    const c = String(code ?? '').trim();
    if (!c || this.state !== 'url') return false;
    this.set('checking', { url: this.url });
    return this.send({ type: 'login_code', code: c }) !== false;
  }

  cancel() {
    if (this.state === 'starting' || this.state === 'url' || this.state === 'checking') this.send({ type: 'login_cancel' });
    this.set('closed');
  }
}

const css = `
#login { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 10; }
#login[hidden] { display: none; }
#login .box { background: #16202e; border: 1px solid #3a4d68; border-radius: 10px; padding: 20px 24px; width: min(460px, 92vw); font: 15px system-ui, sans-serif; color: #e6edf5; }
#login h2 { margin: 0 0 10px; font-size: 18px; }
#login p { margin: 8px 0; line-height: 1.4; }
#login a.go { display: inline-block; margin: 6px 0; padding: 9px 16px; background: #3b82f6; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; }
#login input { width: 100%; box-sizing: border-box; padding: 9px; margin: 6px 0; background: #0d141d; color: inherit; border: 1px solid #3a4d68; border-radius: 6px; font: 14px monospace; }
#login .row { display: flex; gap: 8px; margin-top: 10px; }
#login .bad { color: #ff8a8a; }
`;

export class LoginDialog {
  constructor(flow, doc = document) {
    this.flow = flow;
    this.doc = doc;
    const style = doc.createElement('style');
    style.textContent = css;
    doc.head.append(style);
    this.root = doc.createElement('div');
    this.root.id = 'login';
    this.root.hidden = true;
    doc.body.append(this.root);
    flow.onChange = () => this.render();
  }

  el(tag, props = {}, ...kids) {
    const e = this.doc.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  }

  render() {
    const f = this.flow;
    this.root.hidden = f.state === 'closed';
    if (f.state === 'closed') return;
    const btn = (label, onclick, props = {}) => this.el('button', { textContent: label, onclick, ...props });
    const box = this.el('div', { className: 'box' }, this.el('h2', { textContent: 'Sign in to Claude' }));
    if (f.state === 'failed') {
      box.append(this.el('p', { className: 'bad', textContent: f.message }),
        this.el('div', { className: 'row' }, btn('Sign in again', () => f.start()), btn('Close', () => f.cancel())));
    } else if (f.state === 'starting') {
      box.append(this.el('p', { textContent: 'Getting a sign-in link...' }), this.el('div', { className: 'row' }, btn('Cancel', () => f.cancel())));
    } else if (f.state === 'url' || f.state === 'checking') {
      const input = this.el('input', { placeholder: 'Paste the code here', autocomplete: 'off', spellcheck: false, disabled: f.state === 'checking' });
      const go = () => f.submit(input.value);
      input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      box.append(
        this.el('p', { textContent: '1. Open the sign-in page, approve, and copy the code it shows.' }),
        this.el('a', { className: 'go', href: f.url, target: '_blank', rel: 'noopener', textContent: 'Open sign-in page' }),
        this.el('p', { textContent: '2. Paste the code here.' }), input,
        this.el('div', { className: 'row' }, btn(f.state === 'checking' ? 'Checking...' : 'Finish', go, { disabled: f.state === 'checking' }), btn('Cancel', () => f.cancel())),
      );
      queueMicrotask(() => input.focus());
    } else if (f.state === 'done') {
      box.append(this.el('p', { textContent: 'Signed in. Send your message again.' }), this.el('div', { className: 'row' }, btn('OK', () => f.cancel())));
    }
    this.root.replaceChildren(box);
  }
}
