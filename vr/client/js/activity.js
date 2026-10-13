// What the Activity window shows, as plain data: a status line and one short row
// per tool call. Pure (no canvas, no clock of its own), so it can be tested.

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const oneLine = (t, max) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The background workers as rows: running first, with how long, then the last few that finished.
export function backgroundRows(convo, now) {
  return (convo.tasks ?? []).map((t) => ({
    id: t.id, text: oneLine(t.description, 120), status: t.status, last: oneLine(t.last, 60), summary: oneLine(t.summary, 160),
    ms: t.startedAt ? (t.endedAt ?? now) - t.startedAt : null,
  }));
}

// The line at the top: what is happening right now, and for how long.
export function headerStatus(convo, now) {
  const turn = convo.turnStarted ? now - convo.turnStarted : null;
  const workers = (convo.tasks ?? []).filter((t) => t.status === 'running').length;
  const running = [...convo.blocks].reverse().find((b) => b.kind === 'tool' && b.status === 'running');
  switch (convo.state) {
    case 'working':
      return { tone: 'working', label: 'Working', time: fmtDuration(turn), detail: running ? oneLine(running.summary, 90) : 'Thinking', workers };
    case 'waiting':
      return { tone: 'waiting', label: 'Needs your answer', time: fmtDuration(turn), detail: oneLine(convo.pending?.text.split('\n').slice(-1)[0], 90), workers };
    case 'idle': {
      const took = convo.turnStarted && convo.turnEnded ? fmtDuration(convo.turnEnded - convo.turnStarted) : '';
      // Free to talk, even with workers going: that is the point of them.
      return { tone: 'idle', label: 'Ready', time: '', detail: workers ? `${plural(workers, 'worker', 'workers')} running` : took ? `Last turn took ${took}` : '', workers };
    }
    case 'connecting': return { tone: 'connecting', label: 'Connecting', time: '', detail: convo.status || '', workers };
    default: return { tone: 'offline', label: 'Offline', time: '', detail: convo.status || '', workers };
  }
}

// One row per thing worth a glance, oldest first:
//   {kind:'turn', text}              what you asked (one line)
//   {kind:'tool', status, text, ms}  a tool call; ms is how long it took, or has taken so far
//   {kind:'wait', text}              waiting for your answer
//   {kind:'error', text}             something went wrong
export function activityRows(convo, now, { max = 200 } = {}) {
  const rows = [];
  for (const b of convo.blocks) {
    if (b.kind === 'user') rows.push({ kind: 'turn', text: oneLine(b.text, 100) });
    else if (b.kind === 'tool') rows.push({ kind: 'tool', status: b.status, text: oneLine(b.summary, 120), ms: b.started ? (b.ended ?? now) - b.started : null });
    else if (b.kind === 'permission' && b.status === 'pending') rows.push({ kind: 'wait', text: oneLine(b.text.split('\n').slice(-1)[0], 120) });
    else if (b.kind === 'notice' && b.level === 'error') rows.push({ kind: 'error', text: oneLine(b.text, 120) });
  }
  return rows.slice(-max);
}
