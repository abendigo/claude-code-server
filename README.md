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

**Document windows.** The page polls `windows.json` (served next to `index.html`, every 3 s) and shows each entry as a scrollable, read-only markdown window to the left of the conversation:

```json
{ "windows": [ { "id": "handoff", "title": "Handoff", "path": "docs/handoff.md" },
               { "id": "note", "title": "Note", "markdown": "# Hello" } ] }
```

`path` is relative to the same folder (no `..`, no absolute paths or URLs); `markdown` is inline. A new id opens a window, changed content updates it (and brings back one you closed), and an id that leaves the file closes it. A missing file means no windows. With the live-edit loop, whoever can write `/workspace/vr-live/windows.json` (Claude, from the worker) can put a document in front of you; a later bridge tool can drive the same open/update/close calls. The renderer (`markdown.js`, `markdown-panel.js`) handles headings, paragraphs, lists, code, quotes, rules and tables, and flattens inline markup to plain text.

**Activity window.** To the right of the conversation, a glanceable view of what Claude is doing: a status line with a moving spinner and a running timer ("Working 42s", with the tool in progress, or "Needs your answer"), then one short row per tool call, newest at the bottom, with a tick, cross or spinner and a duration. It shows no output or file contents. It reads the same conversation model as the main panel (`activity.js` holds the logic, `activity-panel.js` draws it), so it needs no bridge change. Tool cards no longer appear in the main conversation; add `?tools=1` to the page URL to bring them back there too. Like every window it can be dragged or sent home. Closing it hides it until the page is reloaded (the reset shortcut moves windows but does not reopen closed ones). Background workers appear in a **Workers** section under the status line, one row each with how long it has run, what it last did (or its result when finished) and a **Stop** button (two taps within three seconds); the status line says "Ready, 2 workers running" while you are free to talk. The flat web app shows the same.

**Sessions.** The page follows one session at a time and remembers which (`vr.agent.svc`, `vr.agent.session` in the browser). On load it attaches to the remembered one, otherwise the newest session the service has for this folder, otherwise a new one, and the conversation and Activity window refill from the replayed history (history that the service logged live carries timestamps, so tool durations show; history read back from the SDK's transcript has none). If the connection drops (headset off, a deploy, Wi-Fi) it reconnects by itself, waiting 1, 2, 4, 8, then 15 seconds between tries, and attaches to the same session; the screen stays as it was meanwhile and the Activity window says "Reconnecting". A worker without the session service never answers `attach`, and after 1.5 s the page falls back to one session per connection, as before. The **Sessions** button in the Claude header opens the Sessions window (it remembers whether you left it open): newest first, a dot for the state (green ready, blue working, amber needs your answer, grey asleep), the first thing you asked, how long ago; tap a row to switch, **New** for a fresh session (the old one keeps running), and a cross on a row ends that session after a second tap. Only sessions from this conversation's folder are listed. A prompt typed in another browser on the same session appears here, and an approval answered elsewhere clears. Spoken replies happen only inside an immersive VR session; a flat screen stays silent.

A long reply that has just finished streaming opens at its first line (its end is the spoken summary), and a "more above" hint shows when the start of the conversation is out of view.

### Flat web app

`/vr/app.html` is the same Claude, in an ordinary web page for a laptop or phone: sessions on the left, the conversation in the middle with a text box (Enter sends, Shift+Enter for a new line), Allow / Always allow / Deny above it when Claude asks, and the Activity pane and any documents on the right. On a narrow screen it shows one pane at a time behind tabs. It talks to the same session service through the same connection code, so a session started in the headset shows up here and the other way round; several devices can follow one session at once, a prompt typed in one appears in the others, and an approval answered in one clears in the rest. It shares the browser's saved session with the VR page (`vr.agent.svc`).

- **Never speaks.** Spoken replies are for VR only. The tab title says "Needs you" or "Done" while the tab is in the background.
- **Microphone** (shown when the hub has a speech-to-text key): click Mic, talk, and it stops by itself after you stop; the text is sent, or answers an approval if you say "yes" / "no".
- **Documents** from `windows.json` appear as tabs under Activity, rendered as markdown. `?tools=1` shows tool calls in the conversation too.
- Code: `client/js/app/` (views, markdown to DOM, actions); everything else it uses is shared with the VR page (`conversation.js`, `agent-client.js`, `session-list.js`, `activity.js`, `markdown.js`). Text is only ever inserted as text, never as HTML.

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
- **Background workers.** A slow job (a build, the tests, bulk edits, research) is handed to a `worker` agent running in the background, so the main session answers in a sentence and you can keep talking to it; when the worker finishes, the idle session wakes by itself and tells you the result (and, in VR, speaks it). Claude is told to run at most four at a time. This uses the SDK's own background agents (`agents.worker` with `background: true`); `AGENT_WORKERS=0` turns it off and `AGENT_WORKER_MODEL` picks the workers' model (default: the main one). Stop in the conversation ends the current turn only (`perTaskStopAffordance`); a worker is stopped on its own with `{type:'stop_task', task}`. The service tracks them (`task_started`, `task_progress`, `task_notification`, and the live set `background_tasks_changed`, which is the authority; only subagents count, not the shell commands they run) and sends `{type:'tasks', session, tasks}` whenever they change, and with `attached`. A worker that is running makes the service **busy**, so the idle reaper and `update-worker` leave the container alone. Approvals a worker needs come through the main window. A worker stopped or finished while the session is idle wakes it with a short report.
- `gateway-agent/server.mjs` authenticates via the `Remote-User` header Authelia sets, rejects cross-site websocket origins, and starts `dispatch-to-worker <user> agent-bridge` per connection (so it creates/starts the worker exactly as a terminal login does and keeps the idle reaper informed). Max 4 connections per user.
- **Spoken replies:** the bridge asks Claude to end each turn with a one- or two-sentence `<spoken>...</spoken>` summary (set `AGENT_SPOKEN=0` on the worker to stop asking). The VR client hides the tag and says the summary with the browser's `speechSynthesis`; a reply without a tag has its first two sentences spoken instead, and approval requests are spoken too ("Claude wants to ... Say yes or no."). It stays quiet while the microphone is open and stops when you start talking, send, answer or press Stop. The conversation header has a **Speak: On/Off** button (it becomes **Hush** while speaking); the choice is remembered in the browser (`vr.speak`).
- Set `AGENT_CWD` on the stack (default `/workspace`) to choose the directory Claude starts in.
- Test: `cd vr && npm test`, `cd gateway-agent && npm test`, `node --test agent/test/*.test.mjs scripts/test/*.test.mjs`. `cd vr && ./smoke/run.sh` runs the real `main.js` in Node against stubbed browser APIs and a fake session service (startup and wiring, not looks). `node agent/test/real-sdk.smoke.mjs` is a manual check against the real SDK and your login (a few tokens).

Known limits: the container itself stopping (a forced recycle, a crash) still ends a turn in progress, though transcripts survive and sessions resume; Claude's clarifying-question tool and subagent internals aren't surfaced yet; inline markdown (bold, backticks) is shown as plain text.


### Updating a worker to the newest image

Workers are recreated onto a newer image automatically once their owner has been fully disconnected for `IDLE_TIMEOUT_SECONDS` (see `reap-idle-users`). To do it sooner, run this inside the worker (or ask Claude to):

```
update-worker           # restart only if a newer image exists
update-worker --force   # restart regardless, e.g. after changing VR_DEV_USER or other env/mounts
```

A worker has no Docker access, so the command leaves a request file in its own `/workspace`; the gateway's `watch-recycle-requests` notices within ~15s, pulls the image, replies through a file, and (if newer, or `--force`) stops and removes that one container. Your volume is untouched; **your terminal and agent sessions end**, and the next login creates the fresh worker. Tests: `node --test scripts/test/*.test.mjs`.
