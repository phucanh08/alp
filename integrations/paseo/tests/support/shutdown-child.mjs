import { createShutdown } from '../../server/dist/shutdown.js';
const hung = process.argv[2];
const shutdown = createShutdown({
  timeoutMs: 150,
  steps: ['unregister', 'web', 'relay', 'bridge', 'supervision', 'release'].map(name => ({ name, run: () => {
    process.send({ event: name });
    if (name === hung) return new Promise(() => {});
  } })),
  report: stage => process.send({ event: 'timeout', stage }),
  exit: code => process.exit(code),
});
process.on('SIGTERM', () => void shutdown());
process.on('message', () => {});
process.send({ event: 'ready' });
