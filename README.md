# Claude Code Server

A self-hosted Docker container running [Claude Code](https://docs.anthropic.com/claude-code), accessible via SSH and browser terminal (ttyd), routed through Traefik and Tailscale.

## Access Methods

| Method | Details |
|---|---|
| **SSH** | `ssh -p 2222 claude@<tailscale-ip>` |
| **Browser terminal** | `https://claude.your-tailnet.ts.net` |

## Setup

### 1. Clone and push to GitHub
```bash
git clone https://github.com/YOUR_USERNAME/claude-code-server
cd claude-code-server
```

### 2. Set up SSH key volume on your host
Create a directory on the Portainer host and place your `authorized_keys` file in it:
```bash
mkdir -p /opt/claude-code/ssh
cp ~/.ssh/id_rsa.pub /opt/claude-code/ssh/authorized_keys
```
Update the `device` path in `docker-compose.yml` to match.

### 3. Set environment variables in Portainer
Add the following as environment variables in your Portainer stack:
- `ANTHROPIC_API_KEY` — your Anthropic API key

### 4. Update docker-compose.yml
Replace the following placeholders:
- `YOUR_GITHUB_USERNAME` — your GitHub username
- `YOUR_TAILNET` — your Tailscale tailnet name

### 5. Deploy in Portainer
- Go to **Stacks → Add Stack**
- Paste the contents of `docker-compose.yml`
- Set `ANTHROPIC_API_KEY` in the environment variables section
- Deploy

### 6. SSH config (optional, for convenience)
Add to your `~/.ssh/config`:
```
Host claude-dev
    HostName <tailscale-ip>
    Port 2222
    User claude
    IdentityFile ~/.ssh/id_rsa
```
Then connect with `ssh claude-dev`.

## Usage

Once connected (via SSH or browser), cd into `/workspace` and start working:
```bash
cd /workspace
git clone https://github.com/your/repo.git
cd repo
claude
```

## Image

Built automatically via GitHub Actions on every push to `main`.  
Image: `ghcr.io/YOUR_GITHUB_USERNAME/claude-code-server:latest`