#!/bin/bash
# Patch ttyd frontend source and build custom inline.html
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TTYD_HTML="/tmp/ttyd-src/html"

# Clone ttyd source
git clone --depth 1 https://github.com/tsl0922/ttyd.git /tmp/ttyd-src

# Patch index.tsx: append banner to body after app renders
BANNER_HTML=$(cat "$SCRIPT_DIR/custom.html" | sed "s|TTYD_HOST|${TTYD_HOST}|g; s|BUILD_VERSION|${BUILD_VERSION}|g" | tr '\n' ' ' | sed "s|'|\\\\'|g")
cat >> "$TTYD_HTML/src/index.tsx" <<TSEOF

/* eslint-disable */
// Inject custom banner
const banner = document.createElement('div');
banner.innerHTML = '${BANNER_HTML}';
while (banner.firstChild) document.body.appendChild(banner.firstChild);
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
