FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    openssh-server \
    ttyd \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# SSH hardening
RUN mkdir /var/run/sshd && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/UsePAM yes/UsePAM no/' /etc/ssh/sshd_config && \
    echo "AllowUsers claude" >> /etc/ssh/sshd_config

# Set up claude user's SSH dir (key mounted at runtime)
RUN mkdir -p /home/claude/.ssh && \
    chmod 700 /home/claude/.ssh && \
    chown claude:claude /home/claude/.ssh

# Workspace for repos
RUN mkdir -p /workspace && chown claude:claude /workspace

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22 7681

ENTRYPOINT ["/entrypoint.sh"]