#!/bin/bash
set -e

mkdir -p /var/lib/claude-code-dispatch

# Start ttyd. -H makes it read the Remote-User header Authelia/Traefik
# already attach to authenticated requests and expose it as $TTYD_USER to
# whatever it spawns -- here, ttyd-dispatch, which routes the connection to
# that person's own worker container (creating one on first login).
ttyd -W -w / -p 7681 -I /usr/local/share/ttyd/index.html -H Remote-User /usr/local/bin/ttyd-dispatch &
ttyd_pid=$!

# Websocket front for the VR client's agent view (Traefik routes /agent here).
node /opt/agent-gateway/server.mjs &
agent_pid=$!

# Stop worker containers nobody has used in a while. See reap-idle-users.
/usr/local/bin/reap-idle-users &
reaper_pid=$!

# Serve workers' update-worker requests (moves them onto the newest image).
/usr/local/bin/watch-recycle-requests &
recycler_pid=$!

shutdown() {
    kill "$reaper_pid" "$recycler_pid" 2>/dev/null || true
    kill -TERM "$agent_pid" 2>/dev/null || true
    kill -TERM "$ttyd_pid" 2>/dev/null || true
    wait "$ttyd_pid" 2>/dev/null || true
    wait "$agent_pid" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

echo "Claude Code gateway started."
echo "  ttyd: port 7681 (routes each authenticated user to their own worker container)"
echo "  agent gateway: port 7682 (websocket to each user's agent-bridge)"

wait
