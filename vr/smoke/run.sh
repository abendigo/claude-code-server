#!/bin/bash
# Copy the client, swap the WebGL renderer for a fake, and run main.js against stubs (see README.md).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .build && mkdir -p .build && cp -r ../client .build/client
sed -i 's/new THREE.WebGLRenderer(/new globalThis.__FakeRenderer(/' .build/client/js/main.js
node run.mjs
