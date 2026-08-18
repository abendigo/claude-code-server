# Claude Code Server

A self-hosted, multi-user [Claude Code](https://docs.anthropic.com/claude-code) environment, accessed via browser terminal (ttyd) through Traefik + Authelia. Every Authelia-authenticated (LDAP) user gets their own container on first login — isolated from each other and from the host — rather than sharing one environment.

## Architecture

Two images, one gateway + N per-user workers:

- **Gateway** (`Dockerfile.gateway`) — the one always-running container. Runs `ttyd` with Authelia's `Remote-User` header wired in (`-H Remote-User`), and dispatches each connection to that user's own worker container, creating one on first login via the host's `docker.sock`. Deliberately lean: no dev tooling, no Claude Code — just enough to route connections. This is the only container with `docker.sock` access.
- **Worker** (`Dockerfile.worker`) — one per user (`claude-code-user-<name>`, volume `workspace-<name>`), created on demand and reused after that. Has the actual dev environment (Claude Code, git, tmux, gh, VS Code CLI) plus its own private Docker-in-Docker daemon (`--privileged`, no host socket) so users can build/run their own containers without touching the host or each other. Runs its own `code tunnel` for VS Code Remote Tunnel access under that user's own identity.

Idle workers are stopped (not removed) after `IDLE_TIMEOUT_SECONDS` of inactivity; their volume persists and the next login just restarts them.

SSH access is not currently supported — dropped in favor of shipping the multi-user browser path first. See project notes for the planned approach if/when it comes back.

Access is gated by whatever your Authelia `access_control` rules allow for the domain this is routed at — currently any authenticated LDAP user, with per-container-per-user isolation as the safety boundary rather than an allowlist.

## Setup

### 1. Clone and push to GitHub
```bash
git clone https://github.com/YOUR_USERNAME/claude-code-server
cd claude-code-server
```

### 2. Set environment variables in Portainer
- `ANTHROPIC_API_KEY` — your Anthropic API key (passed through to every worker)

### 3. Update docker-compose.yml
Replace `abendigo` in the `image:`/`WORKER_IMAGE` references with your GitHub username, and adjust the Traefik `Host()` rule / `traefik_default` network name to match your setup.

### 4. Deploy in Portainer
- Go to **Stacks → Add Stack**
- Paste the contents of `docker-compose.yml`
- Set `ANTHROPIC_API_KEY` in the environment variables section
- Deploy

### 5. If migrating from the single-container version
The old setup's `workspace` volume has your existing home directory content. To carry it over to your own worker container instead of starting fresh, once your worker (`claude-code-user-<you>`) has been created by logging in once:
```bash
docker run --rm -v workspace:/from -v workspace-<you>:/to alpine sh -c "cp -a /from/. /to/"
docker restart claude-code-user-<you>
```

## Usage

Log into `https://claude.your-domain` — Authelia authenticates you, and you land in your own container. `cd /workspace` and start working:
```bash
cd /workspace
git clone https://github.com/your/repo.git
cd repo
claude
```

## Images

Built automatically via GitHub Actions on every push to `main`.
- Gateway: `ghcr.io/YOUR_GITHUB_USERNAME/claude-code-server:latest`
- Worker: `ghcr.io/YOUR_GITHUB_USERNAME/claude-code-server-worker:latest`