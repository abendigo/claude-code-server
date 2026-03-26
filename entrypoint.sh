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

# Start ttyd as the claude user on port 7681
gosu claude ttyd -W -w /workspace -p 7681 -I /usr/local/share/ttyd/index.html tmux new -A -s ttyd_session /bin/bash -l &

echo "Claude Code server started."
echo "  SSH:  port 22"
echo "  ttyd: port 7681"

# Keep container alive
wait
