#!/bin/bash
set -e

# Start SSH daemon
/usr/sbin/sshd

# Start ttyd as the claude user on port 7681
ttyd -p 7681 -u claude su - claude &

echo "Claude Code server started."
echo "  SSH:  port 22"
echo "  ttyd: port 7681"

# Keep container alive
wait