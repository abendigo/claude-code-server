// Stand-in for `recycle-worker NAME`: what it says depends on the name.
const name = process.argv[2];
console.log('recycle-worker: pretend log line that is not the answer');
if (name === 'current') { console.log('Already up to date: this environment is running the newest worker image.'); process.exit(10); }
if (name === 'broken') { console.log('Could not reach the image registry to check for a newer worker image. Nothing was changed.'); process.exit(1); }
if (name === 'silent') process.exit(1);
console.log('A newer worker image is available. This environment is restarting now and your sessions will end. Log in again to get the new one.');
setTimeout(() => process.exit(0), 1500); // still "stopping the container" after the answer went out
