// The "tools" group: keyboard, quick keys, snippets and terminals. Hidden by
// default when there is a conversation, so the view is just Claude and the
// voice bar; one toggle (voice-bar button, left Y, or F2) brings them back.
// The choice is remembered. Without a conversation there is nothing else to
// look at, so the group starts visible and the choice isn't saved.
const KEY = 'vr.tools';

export class ToolGroup {
  constructor(panels, { persist = true, onChange } = {}) {
    this.panels = panels;
    this.persist = persist;
    this.onChange = onChange;
    let saved = null;
    if (persist) { try { saved = localStorage.getItem(KEY); } catch { /* optional */ } }
    this.visible = persist ? saved === '1' : true;
    this.apply();
  }

  apply() {
    for (const p of this.panels) p.mesh.visible = this.visible;
    this.onChange?.(this.visible);
  }

  set(visible) {
    this.visible = Boolean(visible);
    if (this.persist) { try { localStorage.setItem(KEY, this.visible ? '1' : '0'); } catch { /* optional */ } }
    this.apply();
  }

  toggle() { this.set(!this.visible); }
}
