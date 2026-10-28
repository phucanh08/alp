import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { alpHome } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';

/**
 * `alp terminal allow|deny|status`: the host owner's switch for remote terminals
 * (docs/protocol/alp-json-rpc-v1.md §12.10, issue #121 H). It lives in $ALP_HOME/terminal.json, a
 * file only this user may read or write; no RPC changes it and no backup carries it.
 */
export const TERMINAL_WARNING = (user = os.userInfo().username) => [
  `A remote terminal runs a real shell on this computer as ${user}, with that account's full access:`,
  'every file it can read or write, any program, and the network.',
  'A workspace only picks the directory the shell starts in. It is NOT a sandbox.',
  'Only gateway credentials that hold the terminal.exec permission can open one (never a default);',
  'Paseo app devices paired with this host only after alp terminal allow --paseo.',
].join('\n');

const file = home => path.join(home, 'terminal.json');

async function read(home) {
  const info = await lstat(file(home)).catch(() => undefined);
  if (!info) return { exists: false, value: undefined, private: true };
  const own = !process.getuid || info.uid === process.getuid();
  const value = info.isFile() ? await readFile(file(home), 'utf8').then(JSON.parse).catch(() => undefined) : undefined;
  return { exists: true, value, private: info.isFile() && own && !(info.mode & 0o077) };
}

async function write(home, value) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${file(home)}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, file(home)).catch(async error => { await rm(temporary, { force: true }); throw error; });
}

export async function terminalCommand(args, { home = alpHome(), out = console.log } = {}) {
  const [action, ...rest] = args;
  const json = rest.includes('--json');
  const current = await read(home);
  const limits = current.value && typeof current.value.limits === 'object' && current.value.limits ? { limits: current.value.limits } : {};
  const paseo = rest.includes('--paseo');
  const paseoBefore = current.private && current.value?.allowPaseoTerminal === true;
  if (action === 'allow') {
    if (!rest.includes('--yes')) {
      out(`${TERMINAL_WARNING()}\n\nRun again with --yes to allow remote terminals on this host.`);
      process.exitCode = 1;
      return;
    }
    const allowPaseoTerminal = paseo || paseoBefore;
    await write(home, { version: 1, allowRemoteTerminal: true, ...(allowPaseoTerminal ? { allowPaseoTerminal: true } : {}), ...limits });
    out(json ? JSON.stringify({ allowRemoteTerminal: true, allowPaseoTerminal }) : `${TERMINAL_WARNING()}\n\nRemote terminals are allowed on this host (${file(home)})${allowPaseoTerminal ? ', also for every Paseo app device paired with it' : ''}. alp terminal deny turns them off and ends every open one.`);
    return;
  }
  if (action === 'deny') {
    if (paseo) {
      const allowed = current.private && current.value?.allowRemoteTerminal === true;
      await write(home, { version: 1, allowRemoteTerminal: allowed, ...limits });
      out(json ? JSON.stringify({ allowRemoteTerminal: allowed, allowPaseoTerminal: false }) : 'Paseo app devices can no longer open terminals on this host; the bridge ends the terminals it holds.');
      return;
    }
    await write(home, { version: 1, allowRemoteTerminal: false, ...limits });
    out(json ? JSON.stringify({ allowRemoteTerminal: false, allowPaseoTerminal: false }) : 'Remote terminals are off on this host; alpd ends every open terminal within 5 seconds.');
    return;
  }
  if (action === 'status') {
    const allowed = current.private && current.value?.version === 1 && current.value.allowRemoteTerminal === true;
    const allowPaseoTerminal = allowed && current.value.allowPaseoTerminal === true;
    const problem = current.exists && !current.private ? `${file(home)} is not a private file of this user, so terminals stay off` : undefined;
    if (json) out(JSON.stringify({ allowRemoteTerminal: allowed, allowPaseoTerminal, ...limits, ...(problem ? { problem } : {}) }));
    else out([`Remote terminals: ${allowed ? 'allowed' : 'off'}${allowPaseoTerminal ? ' (also for paired Paseo app devices)' : ''}`, ...(problem ? [problem] : []), ...(allowed ? ['', TERMINAL_WARNING()] : [])].join('\n'));
    return;
  }
  throw new UsageError();
}
