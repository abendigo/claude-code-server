#!/bin/bash
set -e

mkdir -p /var/lib/claude-code-dispatch

# Start ttyd. -H makes it read the Remote-User header Authelia/Traefik
# already attach to authenticated requests and expose it as $TTYD_USER to
# whatever it spawns -- here, ttyd-dispatch, which routes the connection to
# that person's own worker container (creating one on first login).
ttyd -W -w / -p 7681 -I /usr/local/share/ttyd/index.html -H Remote-User /usr/local/bin/ttyd-dispatch &
ttyd_pid=$!

# Stop worker containers nobody has used in a while. See reap-idle-users.
/usr/local/bin/reap-idle-users &
reaper_pid=$!

shutdown() {
    kill "$reaper_pid" 2>/dev/null || true
    kill -TERM "$ttyd_pid" 2>/dev/null || true
    wait "$ttyd_pid" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

echo "Claude Code gateway started."
echo "  ttyd: port 7681 (routes each authenticated user to their own worker container)"

wait
