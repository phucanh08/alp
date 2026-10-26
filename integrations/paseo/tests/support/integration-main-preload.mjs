// Preloaded into the real integration entry point (node --import). After the first SIGTERM, the
// integration's guard mkdir (release) is gated over IPC and then fails, so shutdown meets a failed
// release. Nothing else is mocked: acquisition, web startup and signal handling are real.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
const home = process.env.ALP_HOME;
if (!home || !process.env.ALP_LOCK_FIXTURE || !home.startsWith(process.env.ALP_LOCK_FIXTURE + path.sep)) throw new Error('private fixture home required');
const guard = path.join(home, 'integrations/paseo.lock.reclaim');
let armed = false, attempts = 0, signals = 0;
const mkdir = fs.mkdir;
fs.mkdir = async (...args) => {
  if (!armed || String(args[0]) !== guard) return mkdir(...args);
  attempts++;
  if (attempts <= 3) process.send({ event: 'release-attempt', attempts });
  if (attempts === 1) {
    process.send({ event: 'gate' });
    await new Promise(resolve => { const receive = m => { if (m.command === 'resume') { process.off('message', receive); resolve(); } }; process.on('message', receive); });
  }
  throw Object.assign(new Error('injected release guard failure'), { code: 'EIO' });
};
syncBuiltinESMExports();
// Registered before the integration's own handler, so it runs first on each signal.
process.on('SIGTERM', () => { armed = true; signals++; process.send({ event: 'signal', signals }); });
// The integration registers uncaughtException last; its handlers are then all installed.
const on = process.on.bind(process);
process.on = (event, listener) => {
  const result = on(event, listener);
  if (event === 'uncaughtException') queueMicrotask(() => process.send({ event: 'handlers' }));
  return result;
};
process.on('message', message => {
  if (message.command !== 'throw') return;
  // Acknowledge after the integration's uncaughtException handler has run for this error.
  on('uncaughtException', () => process.send({ event: 'thrown' }));
  setImmediate(() => { throw new Error('injected uncaught exception during shutdown'); });
});
