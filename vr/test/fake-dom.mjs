// A very small DOM, enough for the flat web app's views and wiring: elements with
// children, attributes, classes, events and text; no layout, no selectors, no HTML parsing.
// Not a browser: it proves our code builds the elements and calls the handlers we expect.
class TextNode {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parent = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

export class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    const self = this;
    this.classList = {
      add: (...c) => { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...c])].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      toggle: (c, on) => { const has = self.classList.contains(c); if (on ?? !has) self.classList.add(c); else self.classList.remove(c); },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  appendChild(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(typeof n === 'object' ? n : new TextNode(n))); }
  replaceChildren(...ns) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...ns); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach((f) => f(ev)); return true; }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
  focus() {}
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(new TextNode(v)); }
}

// All descendants (depth first), elements only.
export function all(el) { return el.children.flatMap((c) => (c.nodeType === 1 ? [c, ...all(c)] : [])); }
export const byTag = (el, tag) => all(el).filter((e) => e.tagName === tag.toUpperCase());
export const byClass = (el, cls) => all(el).filter((e) => e.classList.contains(cls));
export const textOf = (el) => el.textContent;
export const button = (el, label) => all(el).find((e) => e.tagName === 'BUTTON' && e.textContent === label);

// document with elements for the given ids ({id: tag}), plus what app.js reaches for.
export function installDom(ids = {}) {
  const els = {};
  for (const [id, tag] of Object.entries(ids)) { els[id] = new El(tag); els[id].id = id; }
  const body = new El('body');
  const doc = {
    body, head: new El('head'), hidden: false, title: '',
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    getElementById: (id) => els[id] ?? null,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
  globalThis.document = doc;
  return { doc, els };
}
