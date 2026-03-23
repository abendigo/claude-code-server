#!/bin/bash
set -e

# Fix SSH key permissions if mounted volume
if [ -f /home/claude/.ssh/authorized_keys ]; then
    chmod 600 /home/claude/.ssh/authorized_keys
    chown claude:claude /home/claude/.ssh/authorized_keys
fi

# Generate host SSH keys if not already present
ssh-keygen -A

# Start SSH daemon
/usr/sbin/sshd

# Start ttyd as the claude user on port 7681
ttyd -p 7681 -u claude su - claude &

echo "Claude Code server started."
echo "  SSH:  port 22"
echo "  ttyd: port 7681"

# Keep container alive
wait