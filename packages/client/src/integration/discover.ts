import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { entryCommand } from '@anhlp/alp-core/packaged';
import { dashboardSettings } from '@anhlp/alp-core/user-settings';
import { isSameBoot } from '../daemon/boot.ts';
import { alpHome, BIN_DIRECTORIES, isFile } from '../daemon/paths.ts';
import type { LiveLock } from '../daemon/lock.ts';

/**
 * Integration names are single lowercase path segments: they name `<home>/integrations/<name>.lock`,
 * its guard and `<home>/<name>.json`. Returns the name, or throws a TypeError.
 */
export function assertIntegrationName(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TypeError(`Invalid integration name: ${JSON.stringify(name)}`);
  return name;
}

/** Registration descriptor field names, in priority order. */
const INTEGRATION_DESCRIPTOR_FIELDS = ['main', 'entry', 'path', 'command'];

async function readIntegrationDescriptor(file: string, baseDirs: string[] = []): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    for (const field of INTEGRATION_DESCRIPTOR_FIELDS) {
      const value = raw?.[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      if (path.isAbsolute(value)) {
        if (await isFile(value)) return value;
      } else {
        const bases = [path.dirname(file), ...baseDirs];
        for (const base of bases) {
          const resolved = path.resolve(base, value);
          if (await isFile(resolved)) return resolved;
        }
      }
    }
  } catch {}
  return undefined;
}

async function integrationCandidateFromHome(home: string, name: string): Promise<string | undefined> {
  const descriptors = [
    path.join(home, 'integrations', `${name}.json`),
    path.join(home, 'integrations', name, 'integration.json'),
  ];
  for (const descriptor of descriptors) {
    const entry = await readIntegrationDescriptor(descriptor, [home]);
    if (entry) return entry;
  }
  // Legacy single-file registration.
  const legacy = path.join(home, 'integrations', name, 'main.js');
  return (await isFile(legacy)) ? legacy : undefined;
}

function integrationBinaryName(name: string): string {
  return `alp-${name}-integration`;
}

/** Distribution roots that may carry a bundled integration descriptor. */
async function distributionRoots() {
  const roots: string[] = [];
  const argv = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : undefined;
  if (argv) {
    // The CLI runs from <distribution>/packages/cli/dist, so the distribution root is a few levels
    // up. Resolve the real path first so a symlinked global bin still finds its own root.
    let directory = path.dirname(argv);
    for (let depth = 0; depth < 4; depth += 1) { roots.push(path.resolve(directory, '..')); directory = path.resolve(directory, '..'); }
    // Every package ancestor may carry a bundled descriptor (a full distribution, or the plugin
    // package installed next to it).
    for (let ancestor = path.dirname(argv); ; ancestor = path.dirname(ancestor)) {
      if (await isFile(path.join(ancestor, 'package.json'))) roots.push(ancestor);
      if (path.dirname(ancestor) === ancestor) break;
    }
  }
  // Also consider the current working directory for full distributions.
  roots.push(process.cwd());
  return [...new Set(roots)];
}

/**
 * The entry of integration `name`: an environment override, a descriptor under the home or a
 * distribution root, or an `alp-<name>-integration` binary. Discovery never returns an entry for
 * `dashboard`: that is alp dashboard's service, which ships with the CLI and is started with its
 * explicit entry; nor for `web`, its name before the rename (t-81b0.5). Everything once registered
 * under `web` (the descriptor `integrations/web.json`, the
 * `alp-web-integration` binary, `ALP_WEB_INTEGRATION`) is the Paseo integration from before its
 * rename to `paseo`, which must never run under the web lock. `ALP_WEB_INTEGRATION` is read for
 * `paseo` only, after `ALP_PASEO_INTEGRATION`, for one release (like the alp-web-integration alias).
 */
export async function discoverIntegration(name: string = 'dashboard', options: { home?: string, env?: NodeJS.ProcessEnv, binDirectories?: string[], roots?: string[] } = {}): Promise<string | undefined> {
  // The name becomes a descriptor path under <home>/integrations, so it must stay one safe segment.
  assertIntegrationName(name);
  if (name === 'dashboard' || name === 'web') return undefined;
  const { env = process.env, binDirectories = BIN_DIRECTORIES, roots } = options;
  // Explicit environment override always wins: the integration's own, then the generic one.
  const envCandidates = [
    env[`ALP_${name.toUpperCase()}_INTEGRATION`],
    name === 'paseo' ? env.ALP_WEB_INTEGRATION : undefined,
    env.ALP_INTEGRATION_ENTRY,
  ].filter(Boolean) as string[];
  for (const candidate of envCandidates) if (await isFile(candidate)) return candidate;

  const home = options?.home ? path.resolve(options.home) : alpHome();
  const fromHome = await integrationCandidateFromHome(home, name);
  if (fromHome) return fromHome;

  // A full distribution may describe a bundled integration relative to its own root.
  for (const root of roots ?? await distributionRoots()) {
    for (const descriptorPath of [path.join(root, 'integrations', `${name}.json`), path.join(root, 'integrations', name, 'integration.json')]) {
      const entry = await readIntegrationDescriptor(descriptorPath, [root]);
      if (entry) return entry;
    }
  }

  // Installed integration packages announce themselves on PATH.
  const binary = integrationBinaryName(name);
  for (const directory of [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...binDirectories]) {
    const candidate = await realpath(path.join(directory, binary)).catch(() => undefined);
    if (candidate && await isFile(candidate)) return candidate;
  }
  return undefined;
}

export function integrationAlive(lock: LiveLock | null | undefined): boolean {
  if (!lock || !Number.isSafeInteger(lock.pid) || !isSameBoot(lock)) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * What startIntegration says about integration `name`, and where its service writes its log: alp
 * dashboard (`dashboard`) is part of the CLI, Paseo (`paseo`) an optional package, anything else named as is.
 */
function integrationText(name: string, home: string) {
  const logs = path.join(home, 'logs', 'integrations');
  if (name === 'dashboard') return {
    what: 'alp dashboard',
    log: path.join(logs, 'alp-dashboard.log'),
    missing: 'alp dashboard runs the alp-dashboard service of the ALP CLI, which is started with its entry (packages/cli/dist/alp-dashboard.js); run `alp dashboard`',
  };
  if (name === 'paseo') return {
    what: 'The Paseo integration',
    log: path.join(logs, 'paseo.log'),
    missing: 'The Paseo integration is an optional integration package. Install it (for example `npm install -g @anhlp/alp-paseo@beta`), then run the command again.',
  };
  return {
    what: `ALP integration ${name}`,
    log: path.join(logs, `${name}.log`),
    missing: `ALP integration ${name} is not installed: no ALP_${name.toUpperCase()}_INTEGRATION, descriptor <home>/integrations/${name}.json or alp-${name}-integration binary was found.`,
  };
}

/**
 * Starts integration `name` (default `dashboard`) detached with `--service` (then `args`) unless its lock
 * already names a live owner, then waits until its ready lock and `<home>/<name>.json` name the same
 * pid. `entry` names the script to run with this Node and skips descriptor, environment and PATH
 * discovery; `dashboard` is never discovered, so it needs its entry. `"dashboard": { "enabled": false }`
 * in the home's settings.json (or `web.enabled`, its key before the rename) refuses `dashboard` only.
 */
export async function startIntegration(nameOrOptions: string | { name?: string, entry?: string, home?: string, args?: string[] } = 'dashboard') {
  const options: { name?: string, entry?: string, home?: string, args?: string[] } = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
  const name = assertIntegrationName(options.name ?? 'dashboard');
  if (options.entry !== undefined && (typeof options.entry !== 'string' || !options.entry)) throw new TypeError('startIntegration entry must be a non-empty path');
  const args = options.args ?? [];
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new TypeError('startIntegration args must be a list of strings');
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const home = options.home ? pathMod.resolve(options.home) : alpHome();
  const text = integrationText(name, home);
  // An explicit entry is the caller's own service script: it must exist even when a live owner is
  // reused, and it replaces descriptor, environment and PATH discovery.
  const explicit = options.entry !== undefined ? pathMod.resolve(options.entry) : undefined;
  if (explicit !== undefined && !(await isFile(explicit))) throw new Error(`${text.what}: integration entry not found: ${explicit}`);
  const lockPath = pathMod.join(home, 'integrations', `${name}.lock`);
  const webPath = pathMod.join(home, `${name}.json`);
  const started = explicit ? ` (entry ${explicit})` : '';

  // dashboard.enabled turns off alp dashboard only; other integrations have their own switches.
  if (name === 'dashboard') {
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(pathMod.join(home, 'settings.json'), 'utf8')); } catch {}
    if (dashboardSettings(settings).enabled === false) throw new Error('alp dashboard is disabled by settings ("dashboard.enabled": false).');
  }

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const readLock = async () => {
    try { return JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { return undefined; }
  };
  const readWeb = async () => {
    try { return JSON.parse(await fs.readFile(webPath, 'utf8')); } catch { return undefined; }
  };

  // The authoritative check: the ready integration lock and live <name>.json must name the same pid.
  // A loser of a concurrent start accepts the winning pid after its own contender has exited or
  // the lock already names the winner.
  async function waitForReady() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const lock = await readLock();
      if (lock && integrationAlive(lock) && lock.ready) {
        const info = await readWeb();
        if (info && info.pid === lock.pid) return lock;
      }
      // alp dashboard can fail during bootstrap after the initial exit check (for example a
      // refused uncertain lock). Its service log carries the cause; do not mask it with
      // a readiness/dashboard.json timeout. Check a concurrent winner's ready lock first.
      if (name === 'dashboard' && webStartupFailed()) throw new Error(`${text.what}${started} failed to start; see ${text.log}`);
      await sleep(100);
    }
    const lock = await readLock();
    if (lock && !lock.ready) throw new Error(`${text.what}${started} started but did not become ready; see ${text.log}`);
    if (!lock) throw new Error(explicit ? `${text.what}${started} did not start; see ${text.log}` : text.missing);
    throw new Error(`${text.what}${started} did not publish a ${name}.json matching its lock; see ${text.log}`);
  }

  // Existing-owner waits have no child to observe.
  let webStartupFailed = () => false;
  const existing = await readLock();
  if (existing && integrationAlive(existing)) {
    return waitForReady();
  }

  const entry = explicit ?? await discoverIntegration(name, { home });
  if (!entry) throw new Error(text.missing);

  const { spawn } = await import('node:child_process');
  // The child is detached with its stdio ignored, so it cannot rely on the parent's console. `--service`
  // is the generic contract: the entry writes its own log (the path its error messages advertise) and
  // keeps the process alive as a service. `--register` still prints to stdout and is not passed here.
  // alp dashboard may be an `alp` command (`alp dashboard serve`); other integrations are scripts.
  const launch = name === 'dashboard' ? entryCommand(entry, 'dashboard', ['--service', ...args]) : entryCommand(entry, 'dashboard', ['--service', ...args], undefined, { scriptOnly: true });
  const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true, env: { ...process.env, ALP_HOME: home } });
  let spawnError: Error | null = null;
  child.on('error', error => { spawnError = error; });
  let exited = false;
  child.on('exit', code => { if (code !== 0 && code !== null) exited = true; });
  child.unref();
  webStartupFailed = () => exited;

  if (spawnError) throw spawnError;
  // Give the process a moment to fail immediately on missing entry or bad permissions.
  await sleep(150);
  if (spawnError) throw spawnError;
  if (exited) throw new Error(`${text.what}${explicit ? started : ` (${entry})`} failed to start; see ${text.log}`);

  return waitForReady();
}
