import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlpRuntime, type RuntimeOptions } from '@anhlp/alp-runtime/index';
import { createDaemonServer } from '@anhlp/alp-daemon/server';
import { alpHome, connect, lockAlive, readLock } from '@anhlp/alp-client/index';
import { daemonHeld, startDaemon } from '@anhlp/alp-client/supervise';
import type { ProviderRegistration } from './compat.js';
import { models as runtimeModels, modes, teamModels, templates, toSessionSpec } from './mapping.js';
import { createAlpProvider, type ProviderBackend } from './provider-core.js';
import { createUploadReader } from './uploads.js';

/**
 * The local and embedded provider (ALP's compatibility mode): alpd on this machine, found through
 * its lock in ALP_HOME and started when needed (ALPD §40), or a runtime and daemon in this process
 * for tests and custom runtimes. It reads this machine's library for the teams Paseo shows. The
 * remote provider (remote/provider.ts) shares the core (provider-core.ts) and none of this.
 */

/**
 * Runtime options run an embedded daemon in this process (tests, custom runtimes);
 * without them the provider connects to the user's alpd, starting it when needed.
 */
type Options = Omit<RuntimeOptions, 'templates'> & {
  /** Run the runtime in this process instead of alpd; implied by a custom transport. */
  embedded?: boolean;
  /** Directory holding alpd's lock and socket; defaults to ALP_HOME or ~/.alp. */
  home?: string;
  /** The daemon script to start; defaults to alpd.js next to this bundle. */
  daemonEntry?: string;
  /** Paseo's home, whose uploads a prompt may attach (uploads.ts); defaults to where Paseo keeps it (PASEO_HOME or ~/.paseo). */
  paseoHome?: string;
};

declare const __ALP_DAEMON_ENTRY__: string | undefined;

/**
 * Paseo recompiles and evaluates plugin code, so import.meta.url may not name this
 * bundle. Beyond these candidates (the build machine's path among them), ensureDaemon
 * looks where alpd last recorded itself and for the ALP CLI on PATH.
 */
export function daemonEntry(explicit?: string) {
  const beside = () => { try { return fileURLToPath(new URL('./alpd.js', import.meta.url)); } catch { return undefined; } };
  const candidates = [explicit, process.env.ALP_DAEMON_ENTRY, typeof __ALP_DAEMON_ENTRY__ === 'string' ? __ALP_DAEMON_ENTRY__ : undefined, beside()];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

async function openBackend(options: Options): Promise<ProviderBackend> {
  const { home, daemonEntry: entry, embedded: inProcess, paseoHome: _paseoHome, ...runtimeOptions } = options;
  if (inProcess || runtimeOptions.transport) {
    const runtime = createAlpRuntime({ ...runtimeOptions, templates });
    const server = createDaemonServer({ runtime, socketPath: '', version: 'embedded' });
    const client = server.local();
    return { client, async shutdown() { client.close(); await runtime.shutdown(); } };
  }
  const where = home ?? alpHome();
  const open = async (demand: boolean) => {
    const lock = await readLock(where);
    if (!demand && !(lockAlive(lock) && lock.ready) && await daemonHeld(where)) throw new Error('alpd was stopped with alp daemon stop');
    return connect(await startDaemon({ home: where, entry: daemonEntry(entry) }), { name: 'alp-paseo', version: '1' });
  };
  return { client: await open(true), async shutdown(client) { client.close(); }, relink: open };
}

export function createProvider(options: Options = {}): ProviderRegistration {
  return createAlpProvider({
    description: 'Filesystem-defined ALP agents backed by Codex or Claude Code',
    open: () => openBackend(options),
    teams: cwd => teamModels(cwd),
    spec: (config, persistence) => ({ spec: toSessionSpec(config, persistence) }),
    projectRoot: cwd => cwd ? path.resolve(cwd) : undefined,
    labelOf: id => runtimeModels.find(model => model.id === id),
    modes: () => ({ modes, defaultMode: 'full-access' }),
    // Locally a reconnect has always attached without replay; alpd's own restarts are the cause of
    // a lost connection, so a request it never answered is sent again once it is back.
    cursors: false,
    repeatAfterRelink: true,
    // Paseo's daemon runs on this machine and stored the file: it is read from Paseo's uploads only.
    readUpload: createUploadReader(options.paseoHome === undefined ? {} : { home: () => path.resolve(options.paseoHome!) }),
  });
}
