import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlpRuntime, type RuntimeOptions } from '@anhlp/alp-runtime/index';
import { createDaemonServer } from '@anhlp/alp-daemon/server';
import { alpHome, connect, lockAlive, readLock } from '@anhlp/alp-client/index';
import { daemonHeld, startDaemon } from '@anhlp/alp-client/supervise';
import type { DaemonConnection } from '@anhlp/alp-protocol';
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
export function daemonEntry(explicit?: string, paseoHome?: string) {
  const beside = () => { try { return fileURLToPath(new URL('./alpd.js', import.meta.url)); } catch { return undefined; } };
  const fromPaseo = () => {
    try {
      const home = paseoHome ?? process.env.PASEO_HOME ?? path.join(os.homedir(), '.paseo');
      const configFile = path.join(home, 'config.json');
      if (existsSync(configFile)) {
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        for (const plugin of Object.values(config.plugins ?? {}) as Array<{ path?: string }>) {
          if (plugin?.path) {
            const entry = path.join(plugin.path, 'server', 'dist', 'alpd.js');
            if (existsSync(entry)) return entry;
            const distEntry = path.join(plugin.path, 'dist', 'alpd.js');
            if (existsSync(distEntry)) return distEntry;
          }
        }
      }
    } catch {}
    return undefined;
  };
  const fromCli = () => {
    try {
      const binDirs = [
        ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
        path.join(os.homedir(), '.npm-global', 'bin'),
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
      for (const dir of binDirs) {
        const bin = path.join(dir, 'alp');
        if (!existsSync(bin)) continue;
        const cli = realpathSync(bin);
        const cliDir = path.dirname(cli);
        const candidates = [
          path.join(cliDir, 'alpd.js'),
          path.resolve(cliDir, '..', 'dist', 'alpd.js'),
          path.resolve(cliDir, '..', '..', 'dist', 'alpd.js'),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {}
    return undefined;
  };
  const fromCwd = () => {
    try {
      const candidates = [
        path.join(process.cwd(), 'node_modules', '@anhlp', 'alp-paseo', 'server', 'dist', 'alpd.js'),
        path.join(process.cwd(), 'node_modules', '@anhlp', 'alp', 'dist', 'alpd.js'),
        path.join(process.cwd(), 'node_modules', '@anhlp', 'alp', 'packages', 'cli', 'dist', 'alpd.js'),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
    return undefined;
  };
  const candidates = [
    explicit,
    process.env.ALP_DAEMON_ENTRY,
    fromPaseo(),
    typeof __ALP_DAEMON_ENTRY__ === 'string' ? __ALP_DAEMON_ENTRY__ : undefined,
    beside(),
    fromCli(),
    fromCwd(),
  ];
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
  let closed = false;
  const open = async (demand: boolean, signal?: AbortSignal) => {
    if (closed || signal?.aborted) throw new Error('Provider connection is closed');
    const lock = await readLock(where);
    if (closed || signal?.aborted) throw new Error('Provider connection is closed');
    if (!demand && !(lockAlive(lock) && lock.ready) && await daemonHeld(where)) throw new Error('alpd was stopped with alp daemon stop');
    if (closed || signal?.aborted) throw new Error('Provider connection is closed');
    const socket = await startDaemon({ home: where, entry: daemonEntry(entry, _paseoHome) });
    let connection: DaemonConnection | undefined;
    try {
      if (closed || signal?.aborted) throw new Error('Provider connection is closed');
      connection = await connect(socket, { name: 'alp-paseo', version: '1' });
      if (closed || signal?.aborted) {
        try { connection.close(); } catch {}
        throw new Error('Provider connection is closed');
      }
      return connection;
    } catch (error) {
      if (connection) { try { connection.close(); } catch {} }
      throw error;
    }
  };
  return {
    client: await open(true),
    async shutdown(client) {
      closed = true;
      client.close();
    },
    relink: open,
  };
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
