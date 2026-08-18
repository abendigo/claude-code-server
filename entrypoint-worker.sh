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
gosu claude env HOME=/workspace code tunnel --accept-server-license-terms --name "${TUNNEL_NAME:-claude-code-server}" &
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

echo "Worker environment started."
echo "  VS Code tunnel: name '${TUNNEL_NAME:-claude-code-server}' (see logs for first-time login)"
echo "  Docker-in-Docker: ready"

# Interactive sessions are attached on demand by the gateway via
# `docker exec -it <this container> ttyd-session` -- nothing to start here
# for that; this entrypoint just keeps the background services alive.
wait
