FROM node:24-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    openssh-server \
    sudo \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Install ttyd from GitHub releases
RUN curl -L https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Install custom ttyd index.html with banner
ARG TTYD_HOST=claude.frustrated.blog
RUN mkdir -p /usr/local/share/ttyd
COPY ttyd/index.html /usr/local/share/ttyd/index.html
RUN sed -i "s/TTYD_HOST/${TTYD_HOST}/" /usr/local/share/ttyd/index.html

# Create non-root user with /workspace as home
RUN useradd -m -d /workspace -s /bin/bash claude && \
    passwd -l claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# SSH setup
RUN mkdir /var/run/sshd

# SSH hardening
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config && \
    echo "AllowUsers claude" >> /etc/ssh/sshd_config

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22 7681

ENTRYPOINT ["/entrypoint.sh"]