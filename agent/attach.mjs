#!/usr/bin/env node
// agent-bridge: the gateway runs this inside a user's worker (`docker exec -i`)
// for every page connection. It no longer is the session; it connects stdin and
// stdout to agent-service's socket, starting the service first when it is not
// running. Closing stdin (page gone) only ends this relay: the sessions live on
// in the service. stdout carries ONLY protocol lines; logs go to stderr.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.HOME || '/workspace';
const STATE_DIR = process.env.AGENT_STATE_DIR || path.join(HOME, '.agent');
const SOCKET = process.env.AGENT_SOCKET || path.join(STATE_DIR, 'service.sock');
const SERVICE = process.env.AGENT_SERVICE_PATH || fileURLToPath(new URL('./service.mjs', import.meta.url));
const WAIT_MS = Number(process.env.AGENT_ATTACH_WAIT_MS || 15_000);
const log = (...a) => console.error('[agent-bridge]', ...a);

function startService() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(path.join(STATE_DIR, 'service.log'), 'a');
  // Detached, with its own session, so it survives this relay and the docker exec above it.
  spawn(process.execPath, [SERVICE], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env }).unref();
  log('started agent-service');
}

const tryConnect = () => new Promise((resolve) => {
  const sock = net.connect(SOCKET);
  sock.once('connect', () => resolve(sock));
  sock.once('error', () => resolve(null));
});

async function connect() {
  let started = false;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const sock = await tryConnect();
    if (sock) return sock;
    if (!started) { startService(); started = true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const sock = await connect();
if (!sock) {
  process.stdout.write(JSON.stringify({ type: 'error', message: 'could not reach the agent service' }) + '\n');
  process.exit(1);
}
process.stdin.pipe(sock);
sock.pipe(process.stdout);
sock.on('close', () => process.exit(0));
sock.on('error', () => process.exit(0));
process.stdin.on('end', () => sock.end());
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { sock.destroy(); process.exit(0); });
