import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnose } from '@anhlp/alp-client/doctor';
import { testEntry } from '@anhlp/alp-client/library-test';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { edited } from '../../commands/library/edit.js';
import { TERMINAL_WARNING, terminalCommand } from '../../commands/terminal/index.js';
import type { DashboardOwnerContext, DashboardOwnerHandler } from './index.js';

/**
 * Owner handlers for the host pages of Settings (t-a95b.1 group B; docs/alp/dashboard.md §4.7):
 * Providers, Terminals, Usage, Workspaces and Projects. Each method here has a `handler: true` entry in the
 * `// --- owner: host (group B) ---` block of apps/gateway/src/policy.ts, which lists the params
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
 *   host.workspace.editors / host.workspace.open   Open in editor (Paseo's): the editors of a fixed
 *                           table (EDITORS) installed on this host, and one of them opens the
 *                           directory of a registry workspace named by id; argv without a shell.
 *   host.registry, host.workspace.update, host.workspace.label, host.project.register,
 *   host.project.remove     alpd's registry (registry.owner, workspace.update, project.register,
 *                           project.remove) on the owner's connection, without the gateway's
 *                           per-credential roots. Session placement is never offered.
 */

const invalid = (message: string, data: Record<string, unknown> = {}) => Object.assign(new Error(message), { code: -32602, data: { reason: 'invalid_params', ...data } });

/** An ALP error with a string code (core, client) as a JSON-RPC error the app can show. */
function rpcError(error: any) { // any: whatever was thrown; its code and message are checked here
  if (typeof error?.code === 'number') return error;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const number = code === 'REVISION_CONFLICT' ? 1004 : code === 'NOT_FOUND' ? 1001 : code?.startsWith('INVALID') ? -32602 : 1000;
  return Object.assign(new Error(error?.message ?? String(error)), { code: number, data: { reason: code ? code.toLowerCase() : 'failed' } });
}

/** A required string param. */
function text(value: unknown, name: string, { max = 4096 }: { max?: number } = {}): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}

/** An optional string param. */
const optionalText = (value: unknown, name: string, options?: { max?: number }): string | undefined => value === undefined ? undefined : text(value, name, options);

/** A registry write's ifRevision and requestId, the requestId namespaced to the owner. */
function registryContext(params: Record<string, any>): { ifRevision: number; requestId: string } { // any: the request's params, checked here
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
 */
export function providerOptions(params: Record<string, any>) { // any: the request's params, checked here
  const id = text(params.id, 'id', { max: 64 });
  const command = text(params.command, 'command');
  const values: Record<string, any> = { command }; // any: the option values `edited` takes, strings and string lists
  if (params.args !== undefined) {
    if (!Array.isArray(params.args) || params.args.length > 64 || params.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw invalid('args must be a list of at most 64 strings');
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
    if (!Array.isArray(params.models) || params.models.length > 100 || params.models.some((model: unknown) => typeof model !== 'string' || !model.trim() || model.includes(',') || model.length > 256)) throw invalid('models must be a list of model ids (no commas)');
    if (params.models.length) values.models = params.models.join(',');
  }
  return { id, values };
}

/** alp doctor's checks that are about providers: each runtime's install and login, the ACP providers, their log codes. */
export const PROVIDER_CHECKS = Object.freeze(['codex', 'claude', 'antigravity', 'providers', 'provider log']);

/**
 * alp doctor's checks (diagnose, read only, no --fix) that are about providers, without their fix.
 */
export async function diagnoseProviders(home: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const checks = await diagnose({ home, env });
  return {
    checks: checks.filter(check => PROVIDER_CHECKS.includes(check.id))
      .map(({ id, status, summary, details, hint }) => ({ id, status, summary, ...(details ? { details } : {}), ...(hint ? { hint } : {}) })),
  };
}

/** Runs `alp terminal <args> --json` on `home` and answers its JSON. */
async function terminal(home: string, args: string[]): Promise<any> { // any: the JSON `alp terminal --json` printed
  const lines: string[] = [];
  await terminalCommand([...args, '--json'], { home, out: line => lines.push(line) });
  return JSON.parse(lines.join('\n'));
}

async function terminalStatus(home: string) {
  return { ...await terminal(home, ['status']), warning: TERMINAL_WARNING() };
}

/**
 * A directory to register: absolute, normalized, an existing directory (after links). Answers the
 * path as given, which is what the registry and the dashboard grant keep.
 */
export async function projectDirectory(value: unknown): Promise<string> {
  const directory = text(value, 'directory');
  if (!path.isAbsolute(directory)) throw invalid('directory must be an absolute path');
  if (path.resolve(directory) !== directory) throw invalid('directory must be a normalized absolute path (no .., no trailing separator)');
  if (!await lstat(directory).then(() => true, () => false)) throw invalid(`${directory} does not exist`);
  const real = await realpath(directory).catch(() => undefined);
  if (!real || !await stat(real).then(info => info.isDirectory(), () => false)) throw invalid(`${directory} is not a directory`);
  return directory;
}

/** The owner's view of alpd's registry: live projects, their workspaces (archived too), the label catalogue. */
export function ownerRegistry(registry: any) { // any: alpd's registry.owner answer, as it came; the entries below are read as given
  const projects = (registry?.projects ?? []).filter((project: any /* any: a registry entry as alpd gave it */) => !project.removedAt);
  const live = new Set(projects.map((project: any /* any: a registry entry as alpd gave it */) => project.id));
  const sessions: Record<string, number> = {};
  for (const workspaceId of Object.values(registry?.sessions ?? {})) sessions[String(workspaceId)] = (sessions[String(workspaceId)] ?? 0) + 1;
  return {
    revision: registry?.revision ?? 0,
    projects: projects.map((project: any /* any: a registry entry as alpd gave it */) => ({ id: project.id, root: project.root, ...(project.customName ? { customName: project.customName } : {}), addedAt: project.addedAt })),
    // any: registry entries as alpd gave them
    workspaces: (registry?.workspaces ?? []).filter((workspace: any) => live.has(workspace.projectId)).map((workspace: any) => ({
      id: workspace.id, projectId: workspace.projectId, directory: workspace.directory, title: workspace.title ?? null,
      pinnedAt: workspace.pinnedAt ?? null, archivedAt: workspace.archivedAt ?? null, labels: workspace.labels ?? [], createdAt: workspace.createdAt,
      managedWorktree: !!workspace.worktree, sessions: sessions[workspace.id] ?? 0,
    })),
    labels: (registry?.labels?.catalog ?? []).map((label: any /* any: a catalogue entry as alpd gave it */) => ({ name: label.name, color: label.color })),
  };
}

/**
 * How the host's file manager opens `directory`: a program and its arguments, run without a shell.
 * The directory is absolute and normalized (projectDirectory), so it never reads as an option.
 * ALP_DASHBOARD_FILE_MANAGER, an absolute program path in alp dashboard's own environment, replaces
 * the platform's (another file manager; the e2e records the call instead of opening a window).
 */
export function revealCommand(platform: NodeJS.Platform, directory: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const chosen = env.ALP_DASHBOARD_FILE_MANAGER;
  if (chosen && path.isAbsolute(chosen)) return [chosen, [directory]];
  if (platform === 'darwin') return ['/usr/bin/open', [directory]];
  if (platform === 'win32') return ['explorer.exe', [directory]];
  return ['xdg-open', [directory]];
}

/** Starts the file manager and leaves it running; replaced in tests. */
export const revealer = {
  run: (file: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  }),
};

/**
 * Open in editor (Paseo's): a FIXED table of editors, the only ones host.workspace.editors lists and
 * host.workspace.open starts. Nothing from the page names a program or a path: the page names an id
 * of this table and a registry workspace. Per platform each editor is found at fixed places only:
 *   mac    an .app bundle under /Applications or ~/Applications (fs stat), opened with
 *          `/usr/bin/open -a <absolute .app> -- <dir>`;
 *   win32  a fixed .exe under %LOCALAPPDATA%\Programs or %ProgramFiles% (JetBrains: the newest
 *          `<prefix>*` folder under %ProgramFiles%\JetBrains or %LOCALAPPDATA%\Programs, then bin\<exe>),
 *          or that .exe on PATH; started as `<absolute .exe> <dir>`;
 *   other  a fixed CLI name on PATH (each absolute PATH entry stat'ed, executable regular file; no
 *          `which`, no shell); started as `<absolute cli> <dir>`.
 * 'finder' is the host's file manager, always present, and does exactly what host.workspace.reveal does.
 */
export type EditorEntry = { id: string; label: string; mac?: string[]; cli?: string[]; exe?: string[]; win?: string[]; jetbrains?: { prefixes: string[]; exe: string } };
export const EDITORS: ReadonlyArray<EditorEntry> = Object.freeze([
  { id: 'vscode', label: 'Visual Studio Code', mac: ['Visual Studio Code.app'], cli: ['code'], exe: ['Code.exe'], win: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'] },
  { id: 'cursor', label: 'Cursor', mac: ['Cursor.app'], cli: ['cursor'], exe: ['Cursor.exe'], win: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
  { id: 'zed', label: 'Zed', mac: ['Zed.app'], cli: ['zed', 'zeditor'], exe: ['Zed.exe'], win: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe'] },
  { id: 'xcode', label: 'Xcode', mac: ['Xcode.app'] },
  { id: 'intellij', label: 'IntelliJ IDEA', mac: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'], cli: ['idea', 'intellij-idea-ultimate', 'intellij-idea-community'], exe: ['idea64.exe'], jetbrains: { prefixes: ['IntelliJ IDEA'], exe: 'idea64.exe' } },
  { id: 'webstorm', label: 'WebStorm', mac: ['WebStorm.app'], cli: ['webstorm'], exe: ['webstorm64.exe'], jetbrains: { prefixes: ['WebStorm'], exe: 'webstorm64.exe' } },
  { id: 'pycharm', label: 'PyCharm', mac: ['PyCharm.app', 'PyCharm Professional Edition.app', 'PyCharm CE.app', 'PyCharm Community Edition.app'], cli: ['pycharm', 'pycharm-professional', 'pycharm-community'], exe: ['pycharm64.exe'], jetbrains: { prefixes: ['PyCharm'], exe: 'pycharm64.exe' } },
  { id: 'goland', label: 'GoLand', mac: ['GoLand.app'], cli: ['goland'], exe: ['goland64.exe'], jetbrains: { prefixes: ['GoLand'], exe: 'goland64.exe' } },
  { id: 'rider', label: 'Rider', mac: ['Rider.app'], cli: ['rider'], exe: ['rider64.exe'], jetbrains: { prefixes: ['JetBrains Rider', 'Rider'], exe: 'rider64.exe' } },
  { id: 'clion', label: 'CLion', mac: ['CLion.app'], cli: ['clion'], exe: ['clion64.exe'], jetbrains: { prefixes: ['CLion'], exe: 'clion64.exe' } },
  { id: 'phpstorm', label: 'PhpStorm', mac: ['PhpStorm.app'], cli: ['phpstorm'], exe: ['phpstorm64.exe'], jetbrains: { prefixes: ['PhpStorm'], exe: 'phpstorm64.exe' } },
  { id: 'rubymine', label: 'RubyMine', mac: ['RubyMine.app'], cli: ['rubymine'], exe: ['rubymine64.exe'], jetbrains: { prefixes: ['RubyMine'], exe: 'rubymine64.exe' } },
  { id: 'android-studio', label: 'Android Studio', mac: ['Android Studio.app'], cli: ['android-studio'], exe: ['studio64.exe'], win: ['%ProgramFiles%\\Android\\Android Studio\\bin\\studio64.exe', '%LOCALAPPDATA%\\Programs\\Android Studio\\bin\\studio64.exe'] },
  { id: 'finder', label: 'File manager' },
].map(entry => Object.freeze(entry)));

/** The file manager's label on `platform`. */
const fileManagerLabel = (platform: NodeJS.Platform): string => platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'File manager';

/**
 * The file-system questions detection asks; replaced in tests. Each answers false on any error.
 */
export type EditorProbe = { isDirectory: (file: string) => Promise<boolean>; isExecutable: (file: string, platform: NodeJS.Platform) => Promise<boolean>; list: (directory: string) => Promise<string[]> };
const fsProbe: EditorProbe = {
  isDirectory: file => stat(file).then(info => info.isDirectory(), () => false),
  isExecutable: (file, platform) => stat(file).then(info => info.isFile() && (platform === 'win32' || (info.mode & 0o111) !== 0), () => false),
  list: directory => readdir(directory).catch(() => []),
};

/**
 * Where detection looks; alp dashboard's own environment, never the page. Replaced in tests.
 */
export type EditorHost = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; probe: EditorProbe };
export const editorHost: EditorHost = { platform: process.platform, env: process.env, home: os.homedir(), probe: fsProbe };

/** A Windows environment variable, case-insensitively. */
function winEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * The absolute PATH entries of `env` (relative ones, such as `.`, are never searched).
 */
function pathEntries(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const value = platform === 'win32' ? winEnv(env, 'PATH') : env.PATH;
  return String(value ?? '').split(platform === 'win32' ? ';' : ':').filter(entry => entry && pathApi.isAbsolute(entry));
}

/**
 * Where `entry` is installed on this host, or undefined: the absolute program (an .app bundle on mac)
 * found at the table's fixed places only.
 */
export async function locateEditor(entry: EditorEntry, { platform, env, home, probe }: EditorHost): Promise<string | undefined> {
  if (platform === 'darwin') {
    for (const bundle of entry.mac ?? []) {
      for (const root of ['/Applications', ...(path.posix.isAbsolute(home) ? [path.posix.join(home, 'Applications')] : [])]) {
        const candidate = path.posix.join(root, bundle);
        if (await probe.isDirectory(candidate)) return candidate;
      }
    }
    return undefined;
  }
  if (platform === 'win32') {
    const local = winEnv(env, 'LOCALAPPDATA');
    const programs = winEnv(env, 'ProgramFiles');
    const expand = (template: string): string | undefined => {
      const value = template.replace('%LOCALAPPDATA%', local ?? '\0').replace('%ProgramFiles%', programs ?? '\0');
      return value.includes('\0') || !path.win32.isAbsolute(value) ? undefined : value;
    };
    for (const template of entry.win ?? []) {
      const candidate = expand(template);
      if (candidate && await probe.isExecutable(candidate, platform)) return candidate;
    }
    if (entry.jetbrains) {
      for (const root of [expand('%ProgramFiles%\\JetBrains'), expand('%LOCALAPPDATA%\\Programs')]) {
        if (!root) continue;
        const folders = (await probe.list(root)).filter(name => entry.jetbrains?.prefixes.some(prefix => name.startsWith(prefix))).sort().reverse();
        for (const folder of folders) {
          const candidate = path.win32.join(root, folder, 'bin', entry.jetbrains.exe);
          if (await probe.isExecutable(candidate, platform)) return candidate;
        }
      }
    }
    for (const directory of pathEntries(platform, env)) {
      for (const name of entry.exe ?? []) {
        const candidate = path.win32.join(directory, name);
        if (await probe.isExecutable(candidate, platform)) return candidate;
      }
    }
    return undefined;
  }
  for (const name of entry.cli ?? []) {
    for (const directory of pathEntries(platform, env)) {
      const candidate = path.posix.join(directory, name);
      if (await probe.isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/**
 * The editors of the table installed on this host, in the table's order, each with where it is
 * ('finder' always, without one). ALP_DASHBOARD_EDITORS, a comma-separated list of table ids in alp
 * dashboard's own environment, replaces detection (e2e): those ids count as installed, at the place
 * detection finds or else the table's first fixed place; unknown ids are ignored.
 */
export async function installedEditors(host: EditorHost = editorHost): Promise<Array<{ id: string; label: string; program?: string }>> {
  const { platform, env } = host;
  const forced = typeof env.ALP_DASHBOARD_EDITORS === 'string' ? new Set(env.ALP_DASHBOARD_EDITORS.split(',').map(id => id.trim()).filter(Boolean)) : undefined;
  const found: Array<{ id: string; label: string; program?: string }> = [];
  for (const entry of EDITORS) {
    if (entry.id === 'finder') { found.push({ id: 'finder', label: fileManagerLabel(platform) }); continue; }
    if (entry.id === 'xcode' && platform !== 'darwin') continue;
    if (forced && !forced.has(entry.id)) continue;
    const program = await locateEditor(entry, host) ?? (forced ? fallbackProgram(entry, platform, env) : undefined);
    if (program) found.push({ id: entry.id, label: entry.label, program });
  }
  return found;
}

/** The table's first fixed place for `entry`, for an id ALP_DASHBOARD_EDITORS forces. */
function fallbackProgram(entry: EditorEntry, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === 'darwin') return entry.mac?.[0] ? path.posix.join('/Applications', entry.mac[0]) : undefined;
  if (platform === 'win32') {
    const template = entry.win?.[0] ?? (entry.jetbrains ? `%ProgramFiles%\\JetBrains\\${entry.jetbrains.prefixes[0]}\\bin\\${entry.jetbrains.exe}` : undefined);
    const value = template?.replace('%LOCALAPPDATA%', winEnv(env, 'LOCALAPPDATA') ?? '\0').replace('%ProgramFiles%', winEnv(env, 'ProgramFiles') ?? '\0');
    return value && !value.includes('\0') && path.win32.isAbsolute(value) ? value : undefined;
  }
  return entry.cli?.[0] ? path.posix.join('/usr/bin', entry.cli[0]) : undefined;
}

/**
 * How `editor` (an installed entry of installedEditors) opens `directory`: a program and its
 * arguments, run without a shell. The directory is absolute and normalized (projectDirectory), so it
 * never reads as an option; on mac `open` also gets `--` before it. ALP_DASHBOARD_EDITOR_RUNNER, an
 * absolute program in alp dashboard's own environment, replaces the editor (e2e records the call):
 * it gets [editorId, directory]. 'finder' is revealCommand (ALP_DASHBOARD_FILE_MANAGER applies).
 */
export function editorCommand(platform: NodeJS.Platform, editor: { id: string; program?: string }, directory: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (editor.id === 'finder') return revealCommand(platform, directory, env);
  const runner = env.ALP_DASHBOARD_EDITOR_RUNNER;
  if (runner && path.isAbsolute(runner)) return [runner, [editor.id, directory]];
  if (!editor.program) throw new Error(`No program for ${editor.id}`);
  if (platform === 'darwin') return ['/usr/bin/open', ['-a', editor.program, '--', directory]];
  return [editor.program, [directory]];
}

const notFound = (message: string, reason: string) => Object.assign(new Error(message), { code: 1001, data: { reason } });

/**
 * The directory of the live (unarchived) workspace of alpd's registry that params.workspaceId names,
 * checked by projectDirectory; never a path from params.
 */
async function liveWorkspaceDirectory(params: Record<string, any>, daemon: DashboardOwnerContext['daemon']): Promise<string> { // any: the request's params, checked here
  const workspaceId = text(params.workspaceId, 'workspaceId', { max: 200 });
  const registry = ownerRegistry(((await daemon.request('registry.owner', {})) as any)?.registry); // any: alpd's answer, read by ownerRegistry
  const workspace = registry.workspaces.find((entry: any /* any: a registry entry as alpd gave it */) => entry.id === workspaceId && !entry.archivedAt);
  if (!workspace) throw notFound(`No workspace ${workspaceId}`, 'not_found');
  return projectDirectory(workspace.directory);
}

const labelName = (value: unknown): string => text(value, 'name', { max: 64 }).trim().replace(/\s+/g, ' ');
function labelColor(value: unknown): string {
  if (typeof value !== 'string' || !LABEL_COLORS.includes(value)) throw invalid(`color must be one of ${LABEL_COLORS.join(', ')}`);
  return value;
}

/** The dashboard's "Check usage" switch (t-9116). */
const usageFile = (home: string): string => path.join(home, 'usage.json');

/**
 * Whether the dashboard checks usage: $ALP_HOME/usage.json's `enabled`, true when the file is
 * missing or says nothing else.
 */
export async function usageSetting(home: string): Promise<{ enabled: boolean; host: string }> {
  const value = await readFile(usageFile(home), 'utf8').then(JSON.parse).catch(() => undefined);
  return { enabled: value?.enabled !== false, host: os.hostname() };
}

/** Writes the switch as terminal.json is written: private to the user, atomically. */
async function writeUsageSetting(home: string, enabled: boolean): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${usageFile(home)}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify({ enabled }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, usageFile(home)).catch(async error => { await rm(temporary, { force: true }); throw error; });
}

export const methods: Readonly<Record<string, DashboardOwnerHandler>> = {
  async 'host.provider.add'({ params, home }) {
    const { id, values } = providerOptions(params);
    try {
      // As alp provider add: the CLI's own content builder, saved to the library, create only.
      const content = await edited('providers', id, undefined, values);
      const saved = await saveEntry('providers', id, content, { scope: 'library', library: home, revision: null });
      const provider = content.provider as any; // any: the provider entry `edited` built, read as given
      return {
        name: id, revision: saved.revision,
        provider: { kind: provider.kind, command: provider.command, args: provider.args ?? [], envKeys: Object.keys(provider.env ?? {}), ...(provider.label ? { label: provider.label } : {}), models: (provider.models ?? []).map((model: any /* any: a model entry of that provider */) => model.id) },
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
    const result = (await daemon.request('registry.owner', {})) as any; // any: alpd's answer, read by ownerRegistry
    return ownerRegistry(result?.registry);
  },

  async 'host.workspace.reveal'({ params, daemon }) {
    const [file, args] = revealCommand(process.platform, await liveWorkspaceDirectory(params, daemon));
    try { await revealer.run(file, args); }
    catch { throw Object.assign(new Error('Could not open the file manager on the host'), { code: 1000, data: { reason: 'reveal_failed' } }); }
    return { opened: true };
  },

  async 'host.workspace.editors'() {
    return { editors: (await installedEditors()).map(({ id, label }) => ({ id, label })) };
  },

  async 'host.workspace.open'({ params, daemon }) {
    const entry = typeof params.editor === 'string' ? EDITORS.find(candidate => candidate.id === params.editor) : undefined;
    if (!entry) throw invalid(`editor must be one of ${EDITORS.map(candidate => candidate.id).join(', ')}`, { reason: 'unknown_editor' });
    const directory = await liveWorkspaceDirectory(params, daemon);
    const editor = (await installedEditors()).find(candidate => candidate.id === entry.id);
    if (!editor) throw notFound(`${entry.label} is not installed on this host`, 'editor_not_installed');
    const [file, args] = editorCommand(editorHost.platform, editor, directory, editorHost.env);
    try { await revealer.run(file, args); }
    catch { throw Object.assign(new Error(`Could not open ${editor.label} on the host`), { code: 1000, data: { reason: 'open_failed' } }); }
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
    let change: { operation: string; args: Record<string, unknown> };
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
    const result = (await daemon.request('registry.owner', { ...change, ...context })) as any; // any: alpd's answer, read as given and by ownerRegistry
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
