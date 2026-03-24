#!/bin/bash
set -e

# Generate host SSH keys if not already present
ssh-keygen -A

# Copy mounted SSH keys to a writable location (mount is read-only)
if [ -f /home/claude/.ssh/authorized_keys ]; then
    cp /home/claude/.ssh/authorized_keys /tmp/authorized_keys
    mkdir -p /home/claude/.ssh_writable
    mv /tmp/authorized_keys /home/claude/.ssh_writable/authorized_keys
    chmod 700 /home/claude/.ssh_writable
    chmod 600 /home/claude/.ssh_writable/authorized_keys
    chown -R claude:claude /home/claude/.ssh_writable
    # Point sshd to the writable copy (avoid duplicates on restart)
    grep -q 'AuthorizedKeysFile /home/claude/.ssh_writable/authorized_keys' /etc/ssh/sshd_config || \
        echo "AuthorizedKeysFile /home/claude/.ssh_writable/authorized_keys" >> /etc/ssh/sshd_config
fi

# Start SSH daemon
/usr/sbin/sshd

# Start ttyd as the claude user on port 7681
ttyd -p 7681 su - claude &

echo "Claude Code server started."
echo "  SSH:  port 22"
echo "  ttyd: port 7681"

# Keep container alive
wait