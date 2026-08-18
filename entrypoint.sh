#!/bin/bash
set -e

# Generate host SSH keys if not already present
ssh-keygen -A

# Ensure .ssh directory exists in persistent home volume
mkdir -p /workspace/.ssh

# Copy authorized_keys from read-only mount into persistent .ssh
if [ -f /tmp/authorized_keys ]; then
    cp /tmp/authorized_keys /workspace/.ssh/authorized_keys
    chmod 600 /workspace/.ssh/authorized_keys
fi

chmod 700 /workspace/.ssh
chown -R claude:claude /workspace/.ssh

# Start SSH daemon
/usr/sbin/sshd

# Start ttyd as the claude user on port 7681. Each connection runs the
# session-picker script, which gives it a fresh independent tmux session by
# default (or lets you attach to an existing one to mirror it on purpose).
gosu claude ttyd -W -w /workspace -p 7681 -I /usr/local/share/ttyd/index.html /usr/local/bin/ttyd-session &

# Start a VS Code Remote Tunnel. This makes an outbound-only connection to
# Microsoft's relay, so no inbound port is needed. Auth/tunnel identity is
# stored under the claude user's home (/workspace), so it persists across
# restarts once you complete the one-time device-code login.
# First run: watch this container's logs (or attach via ttyd/SSH) for the
# login URL and code, and approve it with your GitHub/Microsoft account.
gosu claude env HOME=/workspace code tunnel --accept-server-license-terms --name "${TUNNEL_NAME:-claude-code-server}" &

echo "Claude Code server started."
echo "  SSH: port 22"
echo "  ttyd: port 7681"
echo "  VS Code tunnel: name '${TUNNEL_NAME:-claude-code-server}' (see logs for first-time login)"

# Keep container alive
wait
