#!/bin/bash
set -e

# Generate host SSH keys if not already present
ssh-keygen -A

# Copy authorized_keys from read-only mount into persistent .ssh volume
if [ -f /tmp/authorized_keys ]; then
    cp /tmp/authorized_keys /home/claude/.ssh/authorized_keys
    chmod 700 /home/claude/.ssh
    chmod 600 /home/claude/.ssh/authorized_keys
    chown -R claude:claude /home/claude/.ssh
fi

# Start SSH daemon
/usr/sbin/sshd

# Start ttyd as the claude user on port 7681
gosu claude ttyd -W -p 7681 /bin/bash -l &

echo "Claude Code server started."
echo "  SSH:  port 22"
echo "  ttyd: port 7681"

# Keep container alive
wait
