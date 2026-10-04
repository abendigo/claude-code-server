import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalIntent } from '../client/js/transcript.js';

const intents = [
  ['Yes.', 'allow'], ['yeah', 'allow'], ['Okay!', 'allow'], ['go ahead', 'allow'], ['do it', 'allow'], ['Allow', 'allow'],
  ['Always.', 'always'], ['always allow', 'always'], ['yes, always', 'always'],
  ['No.', 'deny'], ['nope', 'deny'], ['Deny', 'deny'], ["don't", 'deny'], ['stop', 'deny'], ['never mind', 'deny'],
  // Sentences are messages, not answers.
  ['yes but only for the tests directory please', null],
  ['no I want you to rewrite the whole file', null],
  ['what does that command do', null],
  ['', null],
];
for (const [heard, want] of intents) {
  test(`approvalIntent: ${JSON.stringify(heard)}`, () => assert.equal(approvalIntent(heard), want));
}
