// The conversation as data: turns the bridge's message stream into a list of
// blocks a panel can draw. Pure logic (no DOM, no sockets), so it can be
// tested with recorded sessions.
//
// Block kinds:
//   user        {text}
//   assistant   {text, streaming}
//   tool        {id, name, summary, status: running|ok|error, detail}
//   permission  {id, tool, text, status: pending|allowed|denied|cancelled}
//   notice      {text, level: info|error}
//
// Speech: onSpeak(text, kind) is called with what should be said aloud: the
// reply's <spoken> summary when a turn finishes ('reply'), or a short request
// when Claude needs an answer ('permission'). See spoken.js.
//
// state: offline | connecting | idle | working | waiting (for your approval)

import { splitSpoken, speakable, fallbackSpoken } from './spoken.js';

export function summarizeTool(name, input = {}) {
  const base = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? '';
  switch (name) {
    case 'Bash': return input.description ? `${input.description}` : String(input.command ?? '');
    case 'Read': return `Read ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Edit ${base(input.file_path)}`;
    case 'Write': return `Write ${base(input.file_path)}`;
    case 'Glob': return `Find ${input.pattern ?? ''}`;
    case 'Grep': return `Search ${input.pattern ?? ''}`;
    case 'WebFetch': return `Fetch ${input.url ?? ''}`;
    case 'WebSearch': return `Search the web: ${input.query ?? ''}`;
    case 'TodoWrite': return 'Updated the plan';
    case 'Task': case 'Agent': return `Subagent: ${input.description ?? ''}`;
    default: return name;
  }
}

// What the approval card says. Prefers the SDK's own wording when present.
export function describePermission(req) {
  if (req.title) return req.title;
  const i = req.input ?? {};
  switch (req.tool) {
    case 'Bash': return `Run this command${i.description ? ` (${i.description})` : ''}:\n${i.command ?? ''}`;
    case 'Edit': case 'MultiEdit': case 'Write': return `${req.tool === 'Write' ? 'Write' : 'Edit'} ${i.file_path ?? 'a file'}`;
    default: return `${req.displayName || req.tool}${Object.keys(i).length ? `: ${JSON.stringify(i).slice(0, 200)}` : ''}`;
  }
}

// What is said when Claude asks permission. Never reads a raw command aloud.
export function spokenPermission(req) {
  const i = req.input ?? {};
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  let what;
  switch (req.tool) {
    case 'Bash': what = i.description ? lower(String(i.description).replace(/[.\s]+$/, '')) : 'run a command'; break;
    case 'Edit': case 'MultiEdit': case 'Write': what = lower(summarizeTool(req.tool, i)); break;
    default: what = `use ${req.displayName || req.tool}`;
  }
  return speakable(`Claude wants to ${what}. Say yes or no.`, 200);
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('\n');
  return '';
}

export class Conversation {
  constructor({ onChange, onSpeak, onAuth } = {}) {
    this.onChange = onChange ?? (() => {});
    this.onSpeak = onSpeak ?? (() => {});
    this.onAuth = onAuth ?? (() => {}); // sign-in messages: auth_required, login_url, login_result
    this.reset();
  }

  reset() {
    this.blocks = [];
    this.state = 'offline';
    this.status = ''; // transient text from the gateway ("creating environment...")
    this.sessionId = null;
    this.model = null;
    this.cwd = null;
    this.last = null; // {ms, cost} of the last finished turn
    this.curMsgId = null;
    this.openText = new Map(); // stream index -> block, for the message being streamed
    this.pending = null; // the permission block awaiting an answer
    this.turnText = ''; // the latest reply text of this turn, and its <spoken> summary, for speaking at the end
    this.turnSpoken = null;
    this.changed();
  }

  changed() { this.onChange(this); }

  setState(state) { this.state = state; this.changed(); }

  notice(text, level = 'info') { this.blocks.push({ kind: 'notice', text, level }); this.changed(); }

  // ---- outgoing: return the message for the bridge ------------------------
  submit(text, { cwd, resume } = {}) {
    const t = text.trim();
    if (!t) return null;
    this.blocks.push({ kind: 'user', text: t });
    this.turnText = '';
    this.turnSpoken = null;
    this.state = 'working';
    this.changed();
    return { type: 'prompt', text: t, ...(cwd ? { cwd } : {}), ...(resume ? { resume } : {}) };
  }

  answer(allow, always = false) {
    const p = this.pending;
    if (!p) return null;
    p.status = allow ? 'allowed' : 'denied';
    this.pending = null;
    this.state = 'working';
    this.changed();
    return { type: 'permission', id: p.id, allow, always: Boolean(allow && always) };
  }

  // ---- incoming ------------------------------------------------------------
  handle(msg) {
    switch (msg.type) {
      case 'sdk': this.handleSdk(msg.message); break;
      case 'permission_request': {
        const block = { kind: 'permission', id: msg.id, tool: msg.tool, text: describePermission(msg), status: 'pending' };
        this.blocks.push(block);
        this.pending = block;
        this.state = 'waiting';
        this.onSpeak(spokenPermission(msg), 'permission');
        break;
      }
      case 'permission_cancelled':
        for (const b of this.blocks) if (b.kind === 'permission' && b.id === msg.id) b.status = 'cancelled';
        if (this.pending?.id === msg.id) { this.pending = null; this.state = 'working'; }
        break;
      case 'auth_required':
        this.notice('Your Claude sign-in has expired. Use the page outside VR to sign in again.', 'error');
        this.onAuth(msg);
        break;
      case 'login_url': case 'login_result': this.onAuth(msg); break;
      case 'status': this.status = msg.text; break;
      case 'error': this.notice(msg.message, 'error'); break;
      case 'exit': case 'closed':
        if (this.pending) { this.pending.status = 'cancelled'; this.pending = null; }
        this.state = 'offline';
        break;
      default: return;
    }
    this.changed();
  }

  handleSdk(m) {
    if (m.parent_tool_use_id) return; // subagent internals: not shown in the spike
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') { this.sessionId = m.session_id; this.model = m.model; this.cwd = m.cwd; this.status = ''; }
        break;
      case 'stream_event': this.handleStream(m.event); break;
      case 'assistant': this.handleAssistant(m.message); break;
      case 'user': this.handleUser(m.message); break;
      case 'result':
        this.last = { ms: m.duration_ms ?? null, cost: m.total_cost_usd ?? null };
        if (m.is_error || (m.subtype && m.subtype !== 'success')) this.notice(`Stopped: ${m.subtype ?? 'error'}`, 'error');
        this.pending = null;
        this.state = 'idle';
        if (m.subtype === 'success' && !m.is_error) {
          const say = speakable(this.turnSpoken ?? '') || fallbackSpoken(this.turnText);
          if (say) this.onSpeak(say, 'reply');
        }
        break;
      default: break;
    }
  }

  handleStream(e) {
    switch (e.type) {
      case 'message_start':
        this.curMsgId = e.message?.id ?? null;
        this.openText.clear();
        break;
      case 'content_block_start':
        if (e.content_block?.type === 'text') {
          const raw = e.content_block.text ?? '';
          const b = { kind: 'assistant', raw, text: splitSpoken(raw).text, streaming: true, msgId: this.curMsgId, final: false };
          this.blocks.push(b);
          this.openText.set(e.index, b);
        }
        break;
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta') {
          const b = this.openText.get(e.index);
          if (b) { b.raw += e.delta.text; b.text = splitSpoken(b.raw).text; }
        }
        break;
      case 'content_block_stop': {
        const b = this.openText.get(e.index);
        if (b) { b.streaming = false; this.openText.delete(e.index); }
        break;
      }
      default: break;
    }
  }

  handleAssistant(message) {
    for (const c of message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) {
        // The complete text is authoritative; reuse the block we streamed into, if any.
        const { text, spoken } = splitSpoken(c.text);
        this.turnText = text;
        this.turnSpoken = spoken;
        const b = [...this.blocks].reverse().find((x) => x.kind === 'assistant' && x.msgId === message.id && !x.final);
        if (b && !text) this.blocks.splice(this.blocks.indexOf(b), 1); // the reply was only the spoken tag
        else if (b) { b.raw = c.text; b.text = text; b.final = true; } else if (text) this.blocks.push({ kind: 'assistant', raw: c.text, text, streaming: false, msgId: message.id, final: true });
      } else if (c.type === 'tool_use') {
        if (!this.blocks.some((x) => x.kind === 'tool' && x.id === c.id)) {
          this.blocks.push({ kind: 'tool', id: c.id, name: c.name, input: c.input, summary: summarizeTool(c.name, c.input), status: 'running', detail: '' });
        }
      }
      // thinking blocks are not shown
    }
  }

  handleUser(message) {
    if (!Array.isArray(message?.content)) return;
    for (const c of message.content) {
      if (c.type !== 'tool_result') continue;
      const b = this.blocks.find((x) => x.kind === 'tool' && x.id === c.tool_use_id);
      if (b) { b.status = c.is_error ? 'error' : 'ok'; b.detail = toolResultText(c.content).slice(0, 2000); }
    }
  }
}
