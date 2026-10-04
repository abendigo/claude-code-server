// Run with: node --test vr/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript } from '../client/js/transcript.js';

const cases = [
  // [mode, heard, typed]
  ['prompt', 'C L A U D E', 'claude'],
  ['prompt', 'C. L. A. U. D. E.', 'claude'],
  ['prompt', 'c-l-a-u-d-e', 'claude'],
  ['prompt', 'Please run clawed on the repo', 'Please run claude on the repo'],
  ['prompt', 'I have a cat and a dog', 'I have a cat and a dog'],
  ['prompt', 'Hello, how are you.', 'Hello, how are you.'], // prose keeps its punctuation
  ['command', 'Clawed.', 'claude'],
  ['command', 'Git log dash dash oneline.', 'git log --oneline'],
  ['command', 'ls dash la', 'ls -la'],
  ['command', 'cd dev slash claude hyphen code hyphen server', 'cd dev/claude-code-server'],
  ['command', 'cat foo dot txt pipe grep bar', 'cat foo.txt | grep bar'],
  ['command', 'cd tilde slash dev', 'cd ~/dev'],
  // The recogniser punctuates like prose; commas must not survive into a command.
  ['command', 'Claude, dash, dash, resume.', 'claude --resume'],
  ['command', 'Claude dash dash resume', 'claude --resume'],
  ['command', 'Claude. Dash dash resume.', 'claude --resume'],
  ['command', 'ls, dash, la', 'ls -la'],
  ['command', 'Git log, dash dash, oneline.', 'git log --oneline'],
  ['command', 'Claude, dash-dash, resume', 'claude --resume'],
  ['command', 'cat foo.txt', 'cat foo.txt'], // a period inside a word is kept
  ['command', 'Claude.', 'claude'],
];

for (const [mode, heard, typed] of cases) {
  test(`${mode}: ${JSON.stringify(heard)}`, () => assert.equal(cleanTranscript(heard, mode), typed));
}
