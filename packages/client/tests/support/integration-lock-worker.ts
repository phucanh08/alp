// Real-process lock exerciser. Gates wrap real fs calls; no acquisition result is mocked.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// `any`: the worker wraps fs/promises functions and FileHandle methods of every signature, forwarding their
// arguments and results unchanged; the parent's commands are JSON messages over IPC.
type Json = any;
const home = process.env.ALP_HOME;
if (!home || !process.env.ALP_LOCK_FIXTURE || !home.startsWith(process.env.ALP_LOCK_FIXTURE + path.sep)) throw new Error('private fixture home required');
const lockName = process.env.ALP_LOCK_NAME;
if (!lockName) throw new Error('ALP_LOCK_NAME required');
const file = path.join(home, 'integrations', `${lockName}.lock`);
const guard = file + '.reclaim';
let gated = false, blocked = false, failed = false;
let opened = 0, closed = 0;
function fault(point: string) { if (!failed && process.env.ALP_LOCK_FAIL === point) { failed = true; throw Object.assign(new Error('injected ' + point), { code: 'EIO' }); } }
async function gate() {
  process.send!({ event: 'gate' });
  await new Promise<void>(resolve => { const receive = (m: Json) => { if (m.command === 'resume') { process.off('message', receive); resolve(); } }; process.on('message', receive); });
}
for (const name of ['open', 'mkdir', 'rename', 'unlink', 'rmdir']) {
  const original = (fs as Record<string, Json>)[name];
  (fs as Record<string, Json>)[name] = async (...args: Json[]) => {
    const target = String(name === 'rename' ? args[1] : args[0]);
    const token = path.dirname(target) === guard;
    if (!gated && ((process.env.ALP_LOCK_GATE === 'guard-initialize' && name === 'open' && token) || (process.env.ALP_LOCK_GATE === 'guard-cleanup' && name === 'rmdir' && target === guard) || (process.env.ALP_LOCK_GATE === 'guard-unlink' && name === 'unlink' && token))) { gated = true; await gate(); }
    if (name === 'open' && token) fault('guard-open');
    if (name === 'unlink' && token) fault('guard-unlink');
    if (name === 'rmdir' && target === guard) fault('guard-rmdir');
    if (name === 'rename' && target === file) fault('ready-rename');
    if (name === 'unlink' && target === file) fault('release-unlink');
    if (!gated && process.env.ALP_LOCK_GATE === 'reclaim' && name === 'unlink' && target === file) { gated = true; await gate(); }
    if (!gated && process.env.ALP_LOCK_GATE === 'ready' && name === 'rename' && target === file) { gated = true; await gate(); }
    try {
      const result = await original(...args);
      if (name === 'open') {
        opened++;
        const close = result.close.bind(result);
        const kind = token ? 'guard' : target === file ? 'main' : 'ready';
        result.close = async () => { await close(); closed++; fault(kind + '-close'); };
        const write = result.writeFile.bind(result), stat = result.stat.bind(result);
        result.writeFile = async (...args: Json[]) => { fault(kind + '-write'); return write(...args); };
        result.stat = async (...args: Json[]) => { fault(kind + '-stat'); return stat(...args); };
      }
      if (name === 'open' && args[1] === 'wx' && target === file && !gated && process.env.ALP_LOCK_GATE === 'initialize') {
        gated = true;
        const write = result.writeFile.bind(result);
        result.writeFile = async (...args: Json[]) => { await gate(); return write(...args); };
      }
      return result;
    } catch (error) {
      if (!blocked && name === 'mkdir' && target === guard && ['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes((error as NodeJS.ErrnoException).code!)) { blocked = true; process.send!({ event: 'blocked' }); }
      throw error;
    }
  };
}
if (process.env.ALP_LOCK_KILL_ERROR) process.kill = () => { throw Object.assign(new Error('injected kill classification'), { code: process.env.ALP_LOCK_KILL_ERROR }); };
syncBuiltinESMExports();
// ALP_LOCK_MODULE points a mutation check at an edited copy; by default the package export is exercised.
const entry = process.env.ALP_LOCK_MODULE;
const { createIntegrationLock } = await import(!entry ? '@anhlp/alp-client/integration-lock' : entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const lock = createIntegrationLock(home, lockName);
async function invoke(message: Json) {
  if (message.command === 'resume') return;
  try {
    const value = message.command === 'acquire' ? await lock.acquire()
      : message.command === 'ready' ? await lock.setReady(message.ready)
      : message.command === 'state' ? { opened, closed }
      : message.command === 'release' ? await lock.release()
      : undefined;
    process.send!({ event: 'result', command: message.command, value });
  } catch (error) { process.send!({ event: 'error', command: message.command, message: (error as Error).message }); }
}
process.on('message', message => { void invoke(message); });
process.send!({ event: 'started' });
