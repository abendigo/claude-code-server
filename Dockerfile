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

# Copy ttyd customization files
COPY ttyd/banner.css /tmp/ttyd/banner.css

# Build custom ttyd index.html with banner
ARG TTYD_HOST=claude.frustrated.blog
RUN ttyd -p 7682 /bin/true & TTYD_PID=$! && \
    curl -s --retry 10 --retry-delay 1 --retry-connrefused http://localhost:7682/ > /tmp/ttyd/default.html && \
    kill $TTYD_PID 2>/dev/null; \
    node -e " \
      const fs = require('fs'); \
      let html = fs.readFileSync('/tmp/ttyd/default.html', 'utf8'); \
      if (!html.includes('<title>ttyd - Terminal</title>')) { console.error('ttyd HTML structure changed — update inject logic'); process.exit(1); } \
      const css = fs.readFileSync('/tmp/ttyd/banner.css', 'utf8').replace('TTYD_HOST', '${TTYD_HOST}'); \
      html = html.replace('<title>ttyd - Terminal</title>', '<title>Claude Code</title>'); \
      html = html.replace('</head>', '<style>' + css + '</style></head>'); \
      fs.mkdirSync('/usr/local/share/ttyd', {recursive: true}); \
      fs.writeFileSync('/usr/local/share/ttyd/index.html', html); \
    " && \
    rm -rf /tmp/ttyd

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