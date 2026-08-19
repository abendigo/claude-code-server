#!/bin/bash
set -e

# Start this worker's own private Docker-in-Docker daemon. Requires
# --privileged (set by dispatch-to-worker when it creates this container).
# This dockerd is entirely private to this container: no path back to the
# host's real daemon or to any other user's worker.
dockerd >/var/log/dockerd.log 2>&1 &
dockerd_pid=$!
for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
done

# Start a VS Code Remote Tunnel under this user's own identity/name. The
# SIGTERM trap below is what lets `code tunnel` flush its session cleanly on
# stop instead of demanding a fresh device-code login every restart -- see
# the graceful-shutdown fix this was carried over from.
#
# Output is teed to a log file (still shows up in `docker logs` too, exactly
# as before) so the MOTD watcher below can pull the device-code login
# prompt out of it -- that prompt is otherwise easy to miss since nobody
# watches container logs day to day.
TUNNEL_LOG=/var/log/code-tunnel.log
gosu claude env HOME=/workspace code tunnel --accept-server-license-terms --name "${TUNNEL_NAME:-claude-code-server}" 2>&1 | tee "$TUNNEL_LOG" &
tunnel_pid=$!

# wait_brief: poll for a pid to exit for up to $1 seconds instead of an
# unbounded `wait`. `code tunnel kill` has been observed to log a shutdown
# message and return immediately without the tunnel process actually
# exiting -- an unbounded wait there hangs the whole container until
# Docker's stop timeout force-kills it, which starves dockerd's own
# shutdown of any time at all. Bounding every step keeps one stuck process
# from blocking the rest of shutdown.
wait_brief() {
    local pid="$1" seconds="$2"
    for _ in $(seq 1 "$seconds"); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 1
    done
}

shutdown() {
    gosu claude env HOME=/workspace timeout 5 code tunnel kill >/dev/null 2>&1 || true
    wait_brief "$tunnel_pid" 5
    kill -TERM "$dockerd_pid" 2>/dev/null || true
    wait_brief "$dockerd_pid" 8
    exit 0
}
trap shutdown TERM INT

# Printed by ttyd-session at the start of each new tmux session -- see the
# comment there for why it can't just be `echo`ed directly into the
# terminal. write_motd() is also called from the log watcher below, so
# TUNNEL_LINE stays the base content and a second line (e.g. a pending
# device-code login prompt) can be appended/cleared as the tunnel's state
# changes.
TUNNEL_LINE="VS Code tunnel: https://vscode.dev/tunnel/${TUNNEL_NAME:-claude-code-server}"
write_motd() {
  {
    echo "$TUNNEL_LINE"
    [ -n "${1:-}" ] && echo "$1"
  } > /etc/motd
}
write_motd

# Surface the tunnel's device-code login prompt (printed once per login
# attempt, e.g. "To grant access to the server, please log into
# https://github.com/login/device and use code XXXX-XXXX") in the MOTD, and
# clear it again once the tunnel actually connects ("Open this link in your
# browser ..."). Runs for the life of the container; dies along with
# everything else in the PID namespace when it's torn down.
(
  tail -n0 -F "$TUNNEL_LOG" 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      *"please log into"*) write_motd "$line" ;;
      *"Open this link in your browser"*) write_motd ;;
    esac
  done
) &

echo "Worker environment started."
echo "  VS Code tunnel: name '${TUNNEL_NAME:-claude-code-server}' (login link appears in /etc/motd if needed)"
echo "  Docker-in-Docker: ready"

# Interactive sessions are attached on demand by the gateway via
# `docker exec -it <this container> ttyd-session` -- nothing to start here
# for that; this entrypoint just keeps the background services alive.
wait
