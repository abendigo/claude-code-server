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

## VR hub (Quest / WebXR)

`vr-hub` serves a WebXR client at `https://<host>/vr/` (same Authelia login as the terminal). Terminals in VR connect to the gateway's ttyd, so nothing about workers changes.

Environment (Portainer, set once): `STT_API_KEY` (speech-to-text key), optionally `STT_URL` / `STT_MODEL` (any OpenAI-compatible transcription endpoint, e.g. Groq's `whisper-large-v3-turbo` for low latency) and `VR_DEV_USER` (see below).

**Releasing:** merge to `main`. CI builds all three images, then a final `deploy` job calls the Portainer webhook once, after every image is pushed. Nothing else is needed.

**Live-editing the client from inside VR:** set `VR_DEV_USER` to your slug (e.g. `mark-oosterveld.org`) and recreate that user's worker once, so it gets the shared volume at `/workspace/vr-live`. Edit `vr/client/` in your checkout, run `vr-sync`, reload the page. The hub serves whichever is newer: the client baked into the image, or your last `vr-sync`. So a deploy after your last sync takes over automatically, and a sync after a deploy shows your edits until the next deploy.

### Agent view (conversation instead of a terminal)

The VR page's main panel is a conversation with Claude Code rather than a terminal: your messages, Claude's streaming replies, one-line tool cards, and Allow / Always allow / Deny buttons when Claude asks permission (or just say "yes" / "no" / "always allow"). Terminals remain available (`?terms=N`, or `?agent=0` to hide the conversation).

### Windows

Everything in the VR scene (the conversation, voice bar, keyboard, quick keys, snippets, terminals) is a window managed by `vr/client/js/windows.js`. Each has a title bar: press its body with the trigger (or the mouse) and drag to move the window, which turns to face you as it goes; the thumbstick resizes while you drag. A grip-grab on the panel itself still works. The **home** button puts that window back where it started, and **close** hides it (not offered for the conversation or voice bar; the Tools toggle brings the others back). Left thumbstick press (F3 on a keyboard) resets every window. Where you leave a window is remembered per window in the browser (`vr.win.<id>`). New kinds of window are a `Panel` subclass passed to `windows.add(panel, { id, title, placement })`.

**Document windows.** The page polls `windows.json` (served next to `index.html`, every 3 s) and shows each entry as a scrollable, read-only markdown window to the right of the conversation:

```json
{ "windows": [ { "id": "handoff", "title": "Handoff", "path": "docs/handoff.md" },
               { "id": "note", "title": "Note", "markdown": "# Hello" } ] }
```

`path` is relative to the same folder (no `..`, no absolute paths or URLs); `markdown` is inline. A new id opens a window, changed content updates it (and brings back one you closed), and an id that leaves the file closes it. A missing file means no windows. With the live-edit loop, whoever can write `/workspace/vr-live/windows.json` (Claude, from the worker) can put a document in front of you; a later bridge tool can drive the same open/update/close calls. The renderer (`markdown.js`, `markdown-panel.js`) handles headings, paragraphs, lists, code, quotes, rules and tables, and flattens inline markup to plain text.

```
Quest page --wss /agent/ws--> gateway (agent-gateway, :7682) --docker exec -i--> agent-bridge (a thin relay)
                                                                                      |  unix socket
                                                                      agent-service (in your worker, long-lived)
                                                                                      |
                                                                                Claude Agent SDK sessions
```

- **`agent/service.mjs` (`agent-service`)** runs inside each worker, started on demand, and owns the Claude Code sessions (`agent/session.mjs`), so they outlive the page: headset off, a reload, Wi-Fi gone, or a gateway deploy only detach the viewer, and the session carries on. Pages attach to a session and, on attach, get its history replayed and any approvals still waiting. It uses the SDK's own matching Claude Code binary and the same `~/.claude` login and settings as the terminal (user/project/local settings apply, so your own allow rules and permission mode still count). Read-only tools (`Read`, `Glob`, `Grep`, `TodoWrite`) never ask; everything else asks unless your settings allow it, and an approval nobody is attached to waits indefinitely. `AGENT_PERMISSION_MODE` (default `default`; `bypassPermissions` for none) sets the mode.
- **`agent/attach.mjs` (`agent-bridge`)** is the command the gateway runs per page connection: it joins stdin/stdout to the service's unix socket (`~/.agent/service.sock`, mode 0600) and starts the service first if it is not running. Closing it only ends that relay. Logs are in `~/.agent/service.log`.
- **Limits:** at most 4 live Claude processes per worker (`AGENT_MAX_LIVE`); an idle session nobody is watching has its process shut down after 30 minutes (`AGENT_IDLE_STOP_MS`) and resumes from its transcript on the next message. A page that never asks to attach (the old client) gets a session of its own that ends with it.
- **Protocol:** JSON lines. Page to service: `attach {session?|sdkId?, cwd?}`, `detach`, `list_sessions`, `close_session`, plus the original `prompt`, `permission`, `interrupt`, `login_*`. Service to page: `attached`, `history`, `sessions`, `session_state`, `user_prompt` (typed in another viewer), plus the original `sdk`, `permission_request`, `permission_cancelled`, `error`, `auth_required`, `closed`. See the header of `agent/service.mjs`.
- **`agent-service busy`** exits 0 while any session is working or waiting for an answer. `reap-idle-users` will not stop such a worker however long nobody has been connected, and `recycle-worker` / `update-worker` refuse to restart it (exit 11, "Not restarting: ...") unless `--force`.
- `gateway-agent/server.mjs` authenticates via the `Remote-User` header Authelia sets, rejects cross-site websocket origins, and starts `dispatch-to-worker <user> agent-bridge` per connection (so it creates/starts the worker exactly as a terminal login does and keeps the idle reaper informed). Max 4 connections per user.
- **Spoken replies:** the bridge asks Claude to end each turn with a one- or two-sentence `<spoken>...</spoken>` summary (set `AGENT_SPOKEN=0` on the worker to stop asking). The VR client hides the tag and says the summary with the browser's `speechSynthesis`; a reply without a tag has its first two sentences spoken instead, and approval requests are spoken too ("Claude wants to ... Say yes or no."). It stays quiet while the microphone is open and stops when you start talking, send, answer or press Stop. The conversation header has a **Speak: On/Off** button (it becomes **Hush** while speaking); the choice is remembered in the browser (`vr.speak`).
- Set `AGENT_CWD` on the stack (default `/workspace`) to choose the directory Claude starts in.
- Test: `cd vr && npm test`, `cd gateway-agent && npm test`, `node --test agent/test/*.test.mjs scripts/test/*.test.mjs`. `node agent/test/real-sdk.smoke.mjs` is a manual check against the real SDK and your login (a few tokens).

Known limits: the container itself stopping (a forced recycle, a crash) still ends a turn in progress, though transcripts survive and sessions resume; until the client changes in the next PR, a page reload still shows a blank conversation (the session is resumed on your first message); Claude's clarifying-question tool and subagent internals aren't surfaced yet; inline markdown (bold, backticks) is shown as plain text.


### Updating a worker to the newest image

Workers are recreated onto a newer image automatically once their owner has been fully disconnected for `IDLE_TIMEOUT_SECONDS` (see `reap-idle-users`). To do it sooner, run this inside the worker (or ask Claude to):

```
update-worker           # restart only if a newer image exists
update-worker --force   # restart regardless, e.g. after changing VR_DEV_USER or other env/mounts
```

A worker has no Docker access, so the command leaves a request file in its own `/workspace`; the gateway's `watch-recycle-requests` notices within ~15s, pulls the image, replies through a file, and (if newer, or `--force`) stops and removes that one container. Your volume is untouched; **your terminal and agent sessions end**, and the next login creates the fresh worker. Tests: `node --test scripts/test/*.test.mjs`.
