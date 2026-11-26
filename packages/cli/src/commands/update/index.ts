import { alpHome, connect, lockAlive, readLock } from '@anhlp/alp-client/index';
import { bundleInfo } from '@anhlp/alp-core/packaged';
import { alpVersion } from '../../version.ts';
import { selfUpdate } from './self-update.ts';

/** The running alpd's version and live sessions, if one runs for this ALP_HOME. */
async function runningDaemon() {
  const lock = await readLock(alpHome());
  if (!lockAlive(lock)) return undefined;
  // lockAlive returned false for a missing lock, so `lock!` below is the lock just read.
  const client = await connect(lock!.socket, { name: 'alp-cli', version: '1' }).catch(() => undefined);
  if (!client) return { version: lock!.version };
  try {
    const status = await client.request('daemon.status');
    return { version: status.version ?? lock!.version, sessions: status.sessions };
  } catch {
    return { version: lock!.version };
  } finally {
    client.close();
  }
}

/** alp update: the bundle's self-update (t-1807); the template upgrade is alp update-template. */
export async function updateCommand(args: string[]) {
  const code = await selfUpdate(args, { bundle: bundleInfo(), version: alpVersion(), daemon: runningDaemon });
  if (code) process.exitCode = code;
}
