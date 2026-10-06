#!/bin/bash
# Patch ttyd frontend source and build custom inline.html
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TTYD_HTML="/tmp/ttyd-src/html"

# Clone ttyd source
git clone --depth 1 https://github.com/tsl0922/ttyd.git /tmp/ttyd-src

# Patch index.tsx: append banner to body after app renders
SHORT_VERSION="${BUILD_VERSION:0:7}"
BANNER_HTML=$(cat "$SCRIPT_DIR/custom.html" | sed "s|TTYD_HOST|${TTYD_HOST}|g; s|BUILD_VERSION|${SHORT_VERSION}|g; s|TUNNEL_NAME|${TUNNEL_NAME}|g" | tr '\n' ' ' | sed "s|'|\\\\'|g")
cat >> "$TTYD_HTML/src/index.tsx" <<TSEOF

/* eslint-disable */
// Inject custom banner
const banner = document.createElement('div');
banner.innerHTML = '${BANNER_HTML}';
while (banner.firstChild) document.body.appendChild(banner.firstChild);

// Menu behaviour: close on an outside click; "Update environment" asks the gateway to
// move this user's worker onto the newest image (it ends their sessions, so confirm first).
document.addEventListener('click', (e) => {
  const menu = document.getElementById('banner-menu') as HTMLDetailsElement | null;
  if (menu && menu.open && !menu.contains(e.target as Node)) menu.open = false;
});
// The VS Code tunnel is per user (named after them), so ask the gateway who this is.
fetch('/agent/me').then((r) => r.json()).then((me) => {
  const link = document.getElementById('banner-vscode') as HTMLAnchorElement | null;
  if (link && me.vscodeUrl) link.href = me.vscodeUrl;
}).catch(() => {});
const updateLink = document.getElementById('banner-update');
if (updateLink) updateLink.addEventListener('click', async (e) => {
  e.preventDefault();
  const menu = document.getElementById('banner-menu') as HTMLDetailsElement | null;
  if (menu) menu.open = false;
  if (!confirm('Update this environment to the newest image?\\n\\nIf one is available, your terminal and agent sessions end and you log in again.')) return;
  try {
    const res = await fetch('/agent/update', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    alert(body.message || (res.ok ? 'Done.' : 'Update failed (' + res.status + ').'));
  } catch (err) {
    alert('Could not reach the gateway: ' + (err as Error).message);
  }
});
TSEOF

# Patch index.scss: append banner styles
CUSTOM_CSS=$(cat "$SCRIPT_DIR/custom.css")
cat >> "$TTYD_HTML/src/style/index.scss" <<SCSSEOF

${CUSTOM_CSS}
SCSSEOF

# Build the frontend
cd "$TTYD_HTML"
corepack enable
yarn install
yarn run inline

# Copy result
mkdir -p /usr/local/share/ttyd
cp "$TTYD_HTML/dist/inline.html" /usr/local/share/ttyd/index.html

# Cleanup
rm -rf /tmp/ttyd-src

echo "Built custom ttyd inline.html at /usr/local/share/ttyd/index.html"
