#!/bin/bash
# Extract ttyd's built-in HTML (with inlined JS/CSS) and inject custom banner + logout button
set -e

OUTPUT="/usr/local/share/ttyd/index.html"

# Start ttyd briefly to grab its default HTML
ttyd -p 9999 echo "extracting" &
TTYD_PID=$!
sleep 1
curl -s http://localhost:9999 > "$OUTPUT"
kill $TTYD_PID 2>/dev/null || true
wait $TTYD_PID 2>/dev/null || true

# Inject custom CSS before </head>
sed -i "s|</head>|<style>\
body::before{content:\"Claude Code · ${TTYD_HOST} · ${BUILD_VERSION}\";position:fixed;top:0;left:0;right:0;z-index:9999;height:32px;line-height:32px;background:#181825;border-bottom:1px solid #313244;padding:0 16px;font-family:monospace;font-size:13px;color:#6c7086;box-sizing:border-box}\
body{margin-top:32px!important}\
#logout-btn{position:fixed;top:6px;right:12px;z-index:10000;color:#6c7086;font-family:monospace;font-size:12px;text-decoration:none;border:1px solid #313244;padding:2px 10px;border-radius:4px;background:#1e1e2e}\
#logout-btn:hover{color:#cdd6f4;border-color:#6c7086;background:#313244}\
</style></head>|" "$OUTPUT"

# Inject logout button after <body>
sed -i 's|<body>|<body><a id="logout-btn" href="https://auth.frustrated.blog/logout">logout</a>|' "$OUTPUT"

echo "Patched ttyd index.html at $OUTPUT"
