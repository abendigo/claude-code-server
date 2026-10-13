// What a list of sessions shows, as plain data (no canvas, no DOM): shared by the
// VR Sessions window and the flat web app.
export const STATE_TEXT = { idle: 'ready', working: 'working', waiting: 'needs your answer', dormant: 'asleep', closed: 'ended' };

export function age(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The rows to show: this conversation's folder only (terminal sessions from elsewhere stay out).
export function visibleSessions(convo) {
  if (!convo) return [];
  const here = convo.attach?.cwd;
  return convo.sessions.filter((r) => !here || !r.cwd || r.cwd === here);
}

// The rows "Clear asleep" would close: asleep (not running, nobody watching) and not the one being followed.
export function asleepRows(convo) {
  return visibleSessions(convo).filter((r) => (r.state ?? 'dormant') === 'dormant' && !(r.session && r.session === convo.attach?.session));
}

// One row as text: label, a state word, and the small print under it.
export function describeSession(row, convo, now) {
  const state = row.state ?? 'dormant';
  const current = Boolean(row.session) && row.session === convo.attach?.session;
  const bits = [STATE_TEXT[state] ?? state];
  if (row.lastModified) bits.push(age(row.lastModified, now));
  if (current) bits.push('this one');
  if (row.viewers > 1) bits.push(`${row.viewers} watching`);
  if (row.workers) bits.push(`${row.workers} ${row.workers === 1 ? 'worker' : 'workers'} running`);
  return { label: (row.summary || '(nothing asked yet)').replace(/\s+/g, ' '), state, current, detail: bits.join(' · '), canEnd: Boolean(row.session || row.sdkId), key: row.session ?? row.sdkId };
}
