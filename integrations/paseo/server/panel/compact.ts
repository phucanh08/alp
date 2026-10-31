import type { PluginServerContext } from './compat.js';
import { alpHome, connect, readLock } from '@anhlp/alp-client/index';
import { agentCompact, compactFirst } from '../../shared/compact.js';

/** In Paseo desktop alpd is reached over its socket, one connection per request. */
export function registerCompactRpc(server: PluginServerContext, open = async () => {
  const lock = await readLock(alpHome());
  if (!lock?.ready) throw new Error('ALP is not running. Start ALP and try again.');
  return connect(lock.socket);
}) {
  server.handle(agentCompact, async ({ sessions }) => {
    const client = await open();
    try { return await compactFirst((method, params) => client.request(method as any, params as any), sessions); }
    finally { client.close(); }
  });
}
