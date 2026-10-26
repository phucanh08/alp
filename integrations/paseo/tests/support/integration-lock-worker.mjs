// Real-process lock exerciser. Gates wrap real fs calls; no acquisition result is mocked.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const home = process.env.ALP_HOME;
if (!home || !process.env.ALP_LOCK_FIXTURE || !home.startsWith(process.env.ALP_LOCK_FIXTURE + path.sep)) throw new Error('private fixture home required');
const file = path.join(home, 'integrations/web.lock');
const guard = file + '.reclaim';
let gated = false, blocked = false, failed = false;
let opened = 0, closed = 0;
function fault(point) { if (!failed && process.env.ALP_LOCK_FAIL === point) { failed = true; throw Object.assign(new Error('injected ' + point), { code: 'EIO' }); } }
async function gate() {
  process.send({ event: 'gate' });
  await new Promise(resolve => { const receive = m => { if (m.command === 'resume') { process.off('message', receive); resolve(); } }; process.on('message', receive); });
}
for (const name of ['open', 'mkdir', 'rename', 'unlink', 'rmdir']) {
  const original = fs[name];
  fs[name] = async (...args) => {
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
        result.writeFile = async (...args) => { fault(kind + '-write'); return write(...args); };
        result.stat = async (...args) => { fault(kind + '-stat'); return stat(...args); };
      }
      if (name === 'open' && args[1] === 'wx' && target === file && !gated && process.env.ALP_LOCK_GATE === 'initialize') {
        gated = true;
        const write = result.writeFile.bind(result);
        result.writeFile = async (...args) => { await gate(); return write(...args); };
      }
      return result;
    } catch (error) {
      if (!blocked && name === 'mkdir' && target === guard && ['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error.code)) { blocked = true; process.send({ event: 'blocked' }); }
      throw error;
    }
  };
}
if (process.env.ALP_LOCK_KILL_ERROR) process.kill = () => { throw Object.assign(new Error('injected kill classification'), { code: process.env.ALP_LOCK_KILL_ERROR }); };
syncBuiltinESMExports();
const entry = process.env.ALP_LOCK_MODULE || new URL('../../server/dist/integration-lock.js', import.meta.url).href;
const { createIntegrationLock } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const lock = createIntegrationLock(home);
async function invoke(message) {
  if (message.command === 'resume') return;
  try {
    const value = message.command === 'acquire' ? await lock.acquire()
      : message.command === 'ready' ? await lock.setReady(message.ready)
      : message.command === 'state' ? { opened, closed }
      : message.command === 'release' ? await lock.release()
      : undefined;
    process.send({ event: 'result', command: message.command, value });
  } catch (error) { process.send({ event: 'error', command: message.command, message: error.message }); }
}
process.on('message', message => { void invoke(message); });
process.send({ event: 'started' });
