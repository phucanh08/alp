import type { PluginServerContext } from './compat.js';
import { alpHome, connect, readLock } from '@anhlp/alp-client/index';
import { usageGet } from '../../shared/usage.js';

/** In Paseo desktop read alpd over its socket; the ALP web host supplies its own connection. */
export function registerUsageRpc(server: PluginServerContext, read = async (refresh = false) => {
  const lock = await readLock(alpHome());
  if (!lock?.ready) throw new Error('ALP is not running. Start ALP and refresh Usage.');
  const client = await connect(lock.socket);
  try { return await client.request('daemon.usage', { refresh }); }
  finally { client.close(); }
}) {
  server.handle(usageGet, async ({ refresh }) => read(refresh));
}
