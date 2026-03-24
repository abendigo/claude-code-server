#!/bin/bash
# Extract ttyd's built-in HTML (with inlined JS/CSS) and inject custom banner + logout button
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="/usr/local/share/ttyd/index.html"

# Start ttyd briefly to grab its default HTML
ttyd -p 9999 echo "extracting" &
TTYD_PID=$!
sleep 1
curl -s http://localhost:9999 > "$OUTPUT"
kill $TTYD_PID 2>/dev/null || true
wait $TTYD_PID 2>/dev/null || true

# Read custom CSS and HTML from files, replace placeholders, collapse to one line
CSS=$(cat "$SCRIPT_DIR/custom.css" | sed "s|TTYD_HOST|${TTYD_HOST}|g; s|BUILD_VERSION|${BUILD_VERSION}|g" | tr '\n' ' ')
HTML=$(cat "$SCRIPT_DIR/custom.html" | sed "s|TTYD_HOST|${TTYD_HOST}|g; s|BUILD_VERSION|${BUILD_VERSION}|g" | tr '\n' ' ')

# Use awk for injection (avoids sed delimiter issues with URLs)
awk -v css="$CSS" '{sub(/<\/head>/, "<style>" css "</style></head>")}1' "$OUTPUT" > "${OUTPUT}.tmp" && mv "${OUTPUT}.tmp" "$OUTPUT"
awk -v html="$HTML" '{sub(/<\/body>/, html "</body>")}1' "$OUTPUT" > "${OUTPUT}.tmp" && mv "${OUTPUT}.tmp" "$OUTPUT"

echo "Patched ttyd index.html at $OUTPUT"
