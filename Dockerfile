FROM node:24-slim AS ttyd-html

# Build custom ttyd frontend with banner + logout button
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
ARG TTYD_HOST=claude.frustrated.blog
ARG BUILD_VERSION=dev
ARG TUNNEL_NAME=claude-code-server
COPY ttyd/ /tmp/ttyd/
RUN chmod +x /tmp/ttyd/patch-index.sh && \
    TTYD_HOST=${TTYD_HOST} BUILD_VERSION=${BUILD_VERSION} TUNNEL_NAME=${TUNNEL_NAME} /tmp/ttyd/patch-index.sh

FROM node:24-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    openssh-server \
    sudo \
    gosu \
    tmux \
    docker.io \
    gh \
    sqlite3 \
    dnsutils \
    whois \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install ttyd from GitHub releases
RUN curl -L https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Install watch-gh-build helper script
COPY scripts/watch-gh-build /usr/local/bin/watch-gh-build
RUN chmod +x /usr/local/bin/watch-gh-build

# Install the VS Code CLI, used to run "code tunnel" for VS Code Remote
# Tunnels (browser or desktop VS Code access without any inbound port).
RUN curl -fL 'https://update.code.visualstudio.com/latest/cli-linux-x64/stable' --output /tmp/vscode_cli.tar.gz && \
    tar -xf /tmp/vscode_cli.tar.gz -C /usr/local/bin && \
    chmod +x /usr/local/bin/code && \
    rm /tmp/vscode_cli.tar.gz

# Install ttyd session picker: run per-connection so each browser tab/device
# gets an independent tmux session by default, with the option to attach to
# (mirror) an existing one.
COPY scripts/ttyd-session /usr/local/bin/ttyd-session
RUN chmod +x /usr/local/bin/ttyd-session

# Copy custom ttyd frontend from build stage
COPY --from=ttyd-html /usr/local/share/ttyd/index.html /usr/local/share/ttyd/index.html

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
