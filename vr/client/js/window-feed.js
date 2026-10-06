// Opens, updates and closes windows from a manifest file the hub serves
// (windows.json next to index.html). Whoever can write that file (Claude, from
// the worker's live-client folder) can put a document in front of you:
//
//   { "windows": [ { "id": "handoff", "title": "Handoff", "path": "docs/handoff.md" },
//                  { "id": "note", "title": "Note", "markdown": "# Hello" } ] }
//
// `path` is read from the same folder (relative, no ".."); `markdown` is inline.
// Windows are matched by id: a new id opens one, changed content updates it
// (and brings back one you closed), and an id that leaves the manifest closes it.
// A window you closed stays closed until its content changes. This is the
// transport for now; the same open/update/close calls can be driven by bridge
// tools later without touching the windows themselves.
const MAX_CHARS = 200_000;
const ID = /^[\w-]{1,40}$/;
const SAFE_PATH = /^(?![a-z][a-z0-9+.-]*:)(?!\/)[\w./-]+$/i;

export function validEntries(manifest) {
  const list = Array.isArray(manifest?.windows) ? manifest.windows : [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !ID.test(e.id ?? '') || seen.has(e.id)) continue;
    const hasPath = typeof e.path === 'string' && SAFE_PATH.test(e.path) && !e.path.split('/').includes('..');
    const hasText = typeof e.markdown === 'string';
    if (!hasPath && !hasText) continue;
    seen.add(e.id);
    out.push({ id: e.id, title: typeof e.title === 'string' && e.title ? e.title.slice(0, 60) : e.id, path: hasText ? null : e.path, markdown: hasText ? e.markdown : null });
  }
  return out;
}

export class WindowFeed {
  constructor({ url = 'windows.json', fetchFn = globalThis.fetch?.bind(globalThis), open, update, close, intervalMs = 3000 }) {
    Object.assign(this, { url, fetchFn, onOpen: open, onUpdate: update, onClose: close, intervalMs });
    this.shown = new Map(); // id -> last content shown
    this.timer = null;
  }

  async readText(path) {
    const r = await this.fetchFn(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.text()).slice(0, MAX_CHARS);
  }

  // One look at the manifest. Resolves quietly on any failure, and leaves things as they are.
  async poll() {
    let entries;
    try {
      const r = await this.fetchFn(this.url, { cache: 'no-store' });
      entries = r.ok ? validEntries(await r.json()) : r.status === 404 ? [] : null;
    } catch { entries = null; } // offline or half-written: keep what is on screen
    if (entries === null) return;

    for (const e of entries) {
      let content;
      try { content = e.markdown !== null ? e.markdown.slice(0, MAX_CHARS) : await this.readText(e.path); } catch { continue; }
      const had = this.shown.get(e.id);
      if (had === undefined) this.onOpen(e, content);
      else if (had !== content) this.onUpdate(e, content);
      this.shown.set(e.id, content);
    }
    const keep = new Set(entries.map((e) => e.id));
    for (const id of [...this.shown.keys()]) {
      if (!keep.has(id)) { this.shown.delete(id); this.onClose(id); }
    }
  }

  start() {
    if (this.timer) return;
    const tick = () => this.poll().catch(() => {});
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
