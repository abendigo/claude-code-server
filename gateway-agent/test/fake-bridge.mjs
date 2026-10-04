// Stand-in for agent-bridge: echoes what it receives, emits a mix of protocol,
// non-protocol and stderr output, and exits when stdin closes.
import readline from 'node:readline';
console.error('[agent-bridge] hidden log');
console.error('creating environment for you...');
console.log('plain non-json line');
console.log(JSON.stringify({ type: 'hello', pid: process.pid }));
readline.createInterface({ input: process.stdin })
  .on('line', (l) => console.log(JSON.stringify({ type: 'echo', got: JSON.parse(l) })))
  .on('close', () => process.exit(0));
