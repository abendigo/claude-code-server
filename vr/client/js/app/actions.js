// What the flat web app does with a conversation and its connection: send a
// prompt, answer an approval, stop. The same rules as the VR conversation window.
export function sendPrompt(convo, client, text, { cwd = '', resumeId = null } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (convo.state === 'waiting') { // answer the approval first
    convo.notice('Answer the approval first: Allow or Deny.', 'error');
    return false;
  }
  // Only a worker without the session service needs the first prompt to say which session to resume.
  return client.send(convo.submit(t, { cwd, resume: client.legacy ? resumeId : undefined }));
}

// kind: 'allow' | 'always' | 'deny'
export function answerApproval(convo, client, kind) {
  return client.send(convo.answer(kind !== 'deny', kind === 'always'));
}

export function stopWork(client) {
  return client.send({ type: 'interrupt' });
}
