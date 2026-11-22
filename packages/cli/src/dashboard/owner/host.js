// @ts-check
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnose } from '@anhlp/alp-client/doctor';
import { testEntry } from '@anhlp/alp-client/library-test';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { edited } from '../../library.js';
import { TERMINAL_WARNING, terminalCommand } from '../../terminal.js';

/**
 * Owner handlers for the host pages of Settings (t-a95b.1 group B; docs/alp/dashboard.md §4.7):
 * Providers, Terminals, Usage, Workspaces and Projects. Each method here has a `handler: true` entry in the
 * `// --- owner: host (group B) ---` block of apps/gateway/src/policy.js, which lists the params
 * that reach it; the values are checked here, before anything runs or reaches alpd.
 *
 * Each one reuses what the CLI does, never a copy of it:
 *   host.provider.add       alp provider add (library.js edited + core saveEntry, library scope,
 *                           create only: an existing provider is never overwritten);
 *   host.provider.test      alp provider test (client library-test testEntry);
 *   host.provider.diagnose  alp doctor's runtime and provider checks (client doctor diagnose, read
 *                           only, never --fix);
 *   host.terminal.status / host.terminal.set   alp terminal status / allow --yes / deny
 *                           (terminal.js terminalCommand, the same $ALP_HOME/terminal.json);
 *   host.usage.setting.get / host.usage.setting.set   Paseo's "Check usage" switch, in
 *                           $ALP_HOME/usage.json (default on). It belongs to the dashboard alone:
 *   daemon.usage            alpd's own, forwarded with its `refresh` param and `account: true` (the
 *                           signed-in email, which alpd gives no other caller) while the switch is on;
 *                           off, answered { disabled: true, providers: [] } without asking alpd, so
 *                           no provider is queried. `alp usage` and alpd's limit watch talk to alpd
 *                           directly and never read the switch (t-9116).
 *   host.workspace.reveal   Open in file manager (Paseo's): the host's file manager opens the
 *                           directory of a registry workspace named by id, never a path from the
 *                           page; argv without a shell (open / explorer.exe / xdg-open).
 *   host.registry, host.workspace.update, host.workspace.label, host.project.register,
 *   host.project.remove     alpd's registry (registry.owner, workspace.update, project.register,
 *                           project.remove) on the owner's connection, without the gateway's
 *                           per-credential roots. Session placement is never offered.
 */

/** @param {string} message @param {Record<string, unknown>} [data] */
const invalid = (message, data = {}) => Object.assign(new Error(message), { code: -32602, data: { reason: 'invalid_params', ...data } });

/** An ALP error with a string code (core, client) as a JSON-RPC error the app can show. @param {any} error */
function rpcError(error) {
  if (typeof error?.code === 'number') return error;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const number = code === 'REVISION_CONFLICT' ? 1004 : code === 'NOT_FOUND' ? 1001 : code?.startsWith('INVALID') ? -32602 : 1000;
  return Object.assign(new Error(error?.message ?? String(error)), { code: number, data: { reason: code ? code.toLowerCase() : 'failed' } });
}

/** A required string param. @param {unknown} value @param {string} name @param {{ max?: number }} [options] @returns {string} */
function text(value, name, { max = 4096 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}

/** An optional string param. @param {unknown} value @param {string} name @param {{ max?: number }} [options] */
const optionalText = (value, name, options) => value === undefined ? undefined : text(value, name, options);

/** A registry write's ifRevision and requestId, the requestId namespaced to the owner. @param {Record<string, any>} params */
function registryContext(params) {
  if (!Number.isSafeInteger(params.ifRevision) || params.ifRevision < 0) throw invalid('ifRevision must be the registry revision you read');
  const requestId = text(params.requestId, 'requestId', { max: 150 });
  return { ifRevision: params.ifRevision, requestId: `dashboard-owner:${requestId}` };
}

/** Environment variable names a provider may set. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Label colours alpd's registry accepts (packages/daemon/src/registry.ts labelColors). */
export const LABEL_COLORS = Object.freeze(['violet', 'sky', 'emerald', 'orange', 'pink', 'indigo', 'teal', 'red', 'amber', 'blue']);

/**
 * `alp provider add`'s options from the method's params, checked: the values the CLI's parser
 * would hand library.js `edited`.
 * @param {Record<string, any>} params
 */
export function providerOptions(params) {
  const id = text(params.id, 'id', { max: 64 });
  const command = text(params.command, 'command');
  /** @type {Record<string, any>} */
  const values = { command };
  if (params.args !== undefined) {
    if (!Array.isArray(params.args) || params.args.length > 64 || params.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw invalid('args must be a list of at most 64 strings');
    if (params.args.length) values.arg = [...params.args];
  }
  if (params.env !== undefined) {
    if (!params.env || typeof params.env !== 'object' || Array.isArray(params.env)) throw invalid('env must be an object of NAME: value');
    const entries = Object.entries(params.env);
    if (entries.length > 64) throw invalid('env takes at most 64 variables');
    for (const [name, value] of entries) {
      if (!ENV_NAME.test(name)) throw invalid(`env name ${JSON.stringify(name)} is not a variable name`);
      if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw invalid(`env ${name} must be a string`);
    }
    if (entries.length) values.env = entries.map(([name, value]) => `${name}=${value}`);
  }
  for (const key of ['label', 'description']) {
    const value = optionalText(params[key], key, { max: 500 });
    if (value !== undefined) values[key] = value;
  }
  if (params.models !== undefined) {
    if (!Array.isArray(params.models) || params.models.length > 100 || params.models.some(model => typeof model !== 'string' || !model.trim() || model.includes(',') || model.length > 256)) throw invalid('models must be a list of model ids (no commas)');
    if (params.models.length) values.models = params.models.join(',');
  }
  return { id, values };
}

/** alp doctor's checks that are about providers: each runtime's install and login, the ACP providers, their log codes. */
export const PROVIDER_CHECKS = Object.freeze(['codex', 'claude', 'antigravity', 'providers', 'provider log']);

/**
 * alp doctor's checks (diagnose, read only, no --fix) that are about providers, without their fix.
 * @param {string} home @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function diagnoseProviders(home, { env = process.env } = {}) {
  const checks = await diagnose({ home, env });
  return {
    checks: checks.filter(check => PROVIDER_CHECKS.includes(check.id))
      .map(({ id, status, summary, details, hint }) => ({ id, status, summary, ...(details ? { details } : {}), ...(hint ? { hint } : {}) })),
  };
}

/** Runs `alp terminal <args> --json` on `home` and answers its JSON. @param {string} home @param {string[]} args */
async function terminal(home, args) {
  /** @type {string[]} */
  const lines = [];
  await terminalCommand([...args, '--json'], { home, out: line => lines.push(line) });
  return JSON.parse(lines.join('\n'));
}

/** @param {string} home */
async function terminalStatus(home) {
  return { ...await terminal(home, ['status']), warning: TERMINAL_WARNING() };
}

/**
 * A directory to register: absolute, normalized, an existing directory (after links). Answers the
 * path as given, which is what the registry and the dashboard grant keep.
 * @param {unknown} value
 */
export async function projectDirectory(value) {
  const directory = text(value, 'directory');
  if (!path.isAbsolute(directory)) throw invalid('directory must be an absolute path');
  if (path.resolve(directory) !== directory) throw invalid('directory must be a normalized absolute path (no .., no trailing separator)');
  if (!await lstat(directory).then(() => true, () => false)) throw invalid(`${directory} does not exist`);
  const real = await realpath(directory).catch(() => undefined);
  if (!real || !await stat(real).then(info => info.isDirectory(), () => false)) throw invalid(`${directory} is not a directory`);
  return directory;
}

/** The owner's view of alpd's registry: live projects, their workspaces (archived too), the label catalogue. @param {any} registry */
export function ownerRegistry(registry) {
  const projects = (registry?.projects ?? []).filter((/** @type {any} */ project) => !project.removedAt);
  const live = new Set(projects.map((/** @type {any} */ project) => project.id));
  /** @type {Record<string, number>} */
  const sessions = {};
  for (const workspaceId of Object.values(registry?.sessions ?? {})) sessions[String(workspaceId)] = (sessions[String(workspaceId)] ?? 0) + 1;
  return {
    revision: registry?.revision ?? 0,
    projects: projects.map((/** @type {any} */ project) => ({ id: project.id, root: project.root, ...(project.customName ? { customName: project.customName } : {}), addedAt: project.addedAt })),
    workspaces: (registry?.workspaces ?? []).filter((/** @type {any} */ workspace) => live.has(workspace.projectId)).map((/** @type {any} */ workspace) => ({
      id: workspace.id, projectId: workspace.projectId, directory: workspace.directory, title: workspace.title ?? null,
      pinnedAt: workspace.pinnedAt ?? null, archivedAt: workspace.archivedAt ?? null, labels: workspace.labels ?? [], createdAt: workspace.createdAt,
      managedWorktree: !!workspace.worktree, sessions: sessions[workspace.id] ?? 0,
    })),
    labels: (registry?.labels?.catalog ?? []).map((/** @type {any} */ label) => ({ name: label.name, color: label.color })),
  };
}

/**
 * How the host's file manager opens `directory`: a program and its arguments, run without a shell.
 * The directory is absolute and normalized (projectDirectory), so it never reads as an option.
 * ALP_DASHBOARD_FILE_MANAGER, an absolute program path in alp dashboard's own environment, replaces
 * the platform's (another file manager; the e2e records the call instead of opening a window).
 * @param {NodeJS.Platform} platform @param {string} directory @param {NodeJS.ProcessEnv} [env] @returns {[string, string[]]}
 */
export function revealCommand(platform, directory, env = process.env) {
  const chosen = env.ALP_DASHBOARD_FILE_MANAGER;
  if (chosen && path.isAbsolute(chosen)) return [chosen, [directory]];
  if (platform === 'darwin') return ['/usr/bin/open', [directory]];
  if (platform === 'win32') return ['explorer.exe', [directory]];
  return ['xdg-open', [directory]];
}

/** Starts the file manager and leaves it running; replaced in tests. */
export const revealer = {
  /** @param {string} file @param {string[]} args @returns {Promise<void>} */
  run: (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  }),
};

/** @param {unknown} value */
const labelName = value => text(value, 'name', { max: 64 }).trim().replace(/\s+/g, ' ');
/** @param {unknown} value */
function labelColor(value) {
  if (typeof value !== 'string' || !LABEL_COLORS.includes(value)) throw invalid(`color must be one of ${LABEL_COLORS.join(', ')}`);
  return value;
}

/** The dashboard's "Check usage" switch (t-9116). @param {string} home */
const usageFile = home => path.join(home, 'usage.json');

/**
 * Whether the dashboard checks usage: $ALP_HOME/usage.json's `enabled`, true when the file is
 * missing or says nothing else. @param {string} home @returns {Promise<{ enabled: boolean, host: string }>}
 */
export async function usageSetting(home) {
  const value = await readFile(usageFile(home), 'utf8').then(JSON.parse).catch(() => undefined);
  return { enabled: value?.enabled !== false, host: os.hostname() };
}

/** Writes the switch as terminal.json is written: private to the user, atomically. @param {string} home @param {boolean} enabled */
async function writeUsageSetting(home, enabled) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${usageFile(home)}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify({ enabled }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, usageFile(home)).catch(async error => { await rm(temporary, { force: true }); throw error; });
}

/** @type {Readonly<Record<string, import('./index.js').DashboardOwnerHandler>>} */
export const methods = {
  async 'host.provider.add'({ params, home }) {
    const { id, values } = providerOptions(params);
    try {
      // As alp provider add: the CLI's own content builder, saved to the library, create only.
      const content = await edited('providers', id, undefined, values);
      const saved = await saveEntry('providers', id, content, { scope: 'library', library: home, revision: null });
      const provider = /** @type {any} */ (content.provider);
      return {
        name: id, revision: saved.revision,
        provider: { kind: provider.kind, command: provider.command, args: provider.args ?? [], envKeys: Object.keys(provider.env ?? {}), ...(provider.label ? { label: provider.label } : {}), models: (provider.models ?? []).map((/** @type {any} */ model) => model.id) },
      };
    } catch (error) { throw rpcError(error); }
  },

  async 'host.provider.test'({ params, home }) {
    const name = text(params.name, 'name', { max: 64 });
    try { return await testEntry('providers', name, { library: home }); }
    catch (error) { throw rpcError(error); }
  },

  async 'host.provider.diagnose'({ home }) {
    return diagnoseProviders(home);
  },

  async 'host.terminal.status'({ home }) {
    return terminalStatus(home);
  },

  async 'host.terminal.set'({ params, home }) {
    if (typeof params.allow !== 'boolean') throw invalid('allow must be true or false');
    // As alp terminal allow without --yes: nothing changes until the warning was confirmed.
    if (params.allow && params.confirm !== true) throw invalid('Allowing remote terminals needs confirm: true, after the warning was shown', { reason: 'confirm_required', warning: TERMINAL_WARNING() });
    await terminal(home, params.allow ? ['allow', '--yes'] : ['deny']);
    return terminalStatus(home);
  },

  async 'host.usage.setting.get'({ home }) {
    return usageSetting(home);
  },

  async 'host.usage.setting.set'({ params, home }) {
    if (typeof params.enabled !== 'boolean') throw invalid('enabled must be true or false');
    await writeUsageSetting(home, params.enabled);
    return usageSetting(home);
  },

  async 'daemon.usage'({ params, home, daemon }) {
    if (!(await usageSetting(home)).enabled) return { disabled: true, providers: [] };
    // The owner's own page shows the signed-in email (Paseo's account label); alpd gives it only on request.
    return daemon.request('daemon.usage', { ...(params.refresh === undefined ? {} : { refresh: params.refresh }), account: true });
  },

  async 'host.registry'({ daemon }) {
    const result = /** @type {any} */ (await daemon.request('registry.owner', {}));
    return ownerRegistry(result?.registry);
  },

  async 'host.workspace.reveal'({ params, daemon }) {
    const workspaceId = text(params.workspaceId, 'workspaceId', { max: 200 });
    const registry = ownerRegistry((/** @type {any} */ (await daemon.request('registry.owner', {})))?.registry);
    const workspace = registry.workspaces.find(entry => entry.id === workspaceId && !entry.archivedAt);
    if (!workspace) throw Object.assign(new Error(`No workspace ${workspaceId}`), { code: 1001, data: { reason: 'not_found' } });
    const [file, args] = revealCommand(process.platform, await projectDirectory(workspace.directory));
    try { await revealer.run(file, args); }
    catch { throw Object.assign(new Error('Could not open the file manager on the host'), { code: 1000, data: { reason: 'reveal_failed' } }); }
    return { opened: true };
  },

  async 'host.workspace.update'({ params, daemon }) {
    const workspaceId = text(params.workspaceId, 'workspaceId', { max: 200 });
    if (typeof params.archived !== 'boolean') throw invalid('archived must be true or false');
    return daemon.request('workspace.update', { workspaceId, archived: params.archived, ...registryContext(params) });
  },

  async 'host.workspace.label'({ params, daemon }) {
    const context = registryContext(params);
    const action = params.action;
    /** @type {{ operation: string, args: Record<string, unknown> }} */
    let change;
    if (action === 'assign' || action === 'unassign') {
      const workspaceId = text(params.workspaceId, 'workspaceId', { max: 200 });
      const label = { name: labelName(params.name), color: action === 'assign' ? labelColor(params.color) : (params.color === undefined ? LABEL_COLORS[0] : labelColor(params.color)) };
      change = { operation: 'label.assign', args: { workspaceId, label, assigned: action === 'assign' } };
    } else if (action === 'update') {
      const args = { name: labelName(params.name), ...(params.newName !== undefined ? { newName: labelName(params.newName) } : {}), ...(params.color !== undefined ? { color: labelColor(params.color) } : {}) };
      if (args.newName === undefined && args.color === undefined) throw invalid('update needs newName or color');
      change = { operation: 'label.update', args };
    } else if (action === 'delete') {
      change = { operation: 'label.delete', args: { name: labelName(params.name) } };
    } else throw invalid('action must be assign, unassign, update or delete');
    const result = /** @type {any} */ (await daemon.request('registry.owner', { ...change, ...context }));
    return { result: result?.result ?? {}, registry: ownerRegistry(result?.registry) };
  },

  async 'host.project.register'({ params, daemon }) {
    const directory = await projectDirectory(params.directory);
    return daemon.request('project.register', { directory, ...registryContext(params) });
  },

  async 'host.project.remove'({ params, daemon }) {
    const projectId = text(params.projectId, 'projectId', { max: 200 });
    return daemon.request('project.remove', { projectId, ...registryContext(params) });
  },
};
