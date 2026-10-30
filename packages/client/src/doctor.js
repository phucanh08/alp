import { realpathSync } from 'node:fs';
import { access, chmod, constants, lstat, readdir, readFile, statfs, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';
import { assertPrivateSocket, connect, daemonPaths, lockAlive, readLock } from './index.js';
import { installedProgram, serviceFor } from './service.js';
import { jsonObject, agentSources, resolveAgent } from '@anhlp/alp-core/resolver';
import { loadHooks } from '@anhlp/alp-core/hooks';
import { isTrusted } from '@anhlp/alp-core/trust';
import { listProviders } from '@anhlp/alp-core/providers';
import { settingsWarnings, validateSettings, validateUserSettings } from '@anhlp/alp-core/validation';
import { readLogTail, scrubText } from '@anhlp/alp-core/log';
import { STATE_SCHEMA, migrationFile, readStateSchema } from '@anhlp/alp-core/state-schema';

/**
 * `alp doctor` (ALPD §36): checks what ALP needs from this machine and project, and
 * what earlier runs may have left behind. Every check reports one of
 * - ok: nothing to do;
 * - info: worth knowing, nothing is wrong;
 * - warn: something to fix, and ALP still works;
 * - fail: ALP cannot work as configured.
 * A check that `--fix` can repair carries a fix. Diagnosing only reads (alpd answers a
 * status request and probes its own state directory); nothing is repaired unless the caller
 * passes the checks to `repair`. Fixes only remove what nothing uses (stale locks, merged
 * branches, entries for vanished projects, kept in a backup) or tighten modes; they never
 * touch sessions, tasks, timelines, running work or unmerged branches. Every line a check
 * reports is scrubbed of credentials, whatever it quotes.
 */

const firstLine = text => text.trim().split('\n')[0] ?? '';

/** The executable `command` names, as a spawn without a shell would find it (on Windows that adds .exe and .com). */
async function executable(command, env) {
  const names = process.platform === 'win32' ? [command, `${command}.exe`, `${command}.com`] : [command];
  const candidates = path.isAbsolute(command) ? names : (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name)));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue; return candidate; } catch {}
  }
  return undefined;
}

/** How to tell whether each native runtime is logged in. */
const RUNTIMES = [
  { kind: 'codex', variable: 'ALP_CODEX_BIN', login: ['login', 'status'], loggedIn: result => result.code === 0, hint: 'codex login' },
  {
    kind: 'claude', variable: 'ALP_CLAUDE_BIN', login: ['auth', 'status'], hint: 'claude auth login',
    loggedIn: result => { try { return JSON.parse(result.stdout).loggedIn === true; } catch { return result.code === 0; } },
  },
  {
    kind: 'antigravity', command: 'agy', variable: 'ALP_ANTIGRAVITY_BIN', login: ['models'], hint: 'agy and sign in',
    loggedIn: result => result.code === 0,
  },
];

async function runtimeChecks({ env, run }) {
  const checks = [];
  for (const runtime of RUNTIMES) {
    const command = env[runtime.variable] || runtime.command || runtime.kind;
    const found = await executable(command, env);
    if (!found) {
      checks.push({ id: runtime.kind, status: 'warn', summary: `${command} not found on PATH; ${runtime.kind} agents cannot run (set ${runtime.variable} to its path)` });
      continue;
    }
    const version = await run(found, ['--version'], { env });
    if (version.code !== 0) {
      checks.push({ id: runtime.kind, status: 'fail', summary: `${found} --version failed: ${firstLine(version.stderr || version.stdout) || `exit ${version.code}`}` });
      continue;
    }
    const login = await run(found, runtime.login, { env });
    checks.push(runtime.loggedIn(login)
      ? { id: runtime.kind, status: 'ok', summary: `${firstLine(version.stdout)} at ${found}, logged in` }
      : { id: runtime.kind, status: 'fail', summary: `${firstLine(version.stdout)} at ${found} is not logged in; run ${runtime.hint}` });
  }
  // One runtime is enough; with neither, nothing can run.
  if (checks.every(check => check.status !== 'ok')) for (const check of checks) if (check.status === 'warn') check.status = 'fail';
  return checks;
}

/** An installed alpd service whose node or alpd.js moved can no longer start alpd. */
async function serviceCheck(home, env) {
  const service = serviceFor({ home, env });
  const program = service && await installedProgram(service);
  if (!program) return undefined;
  const missing = [];
  for (const file of program) if (!await lstat(file).then(() => true, () => false)) missing.push(file);
  return missing.length
    ? { id: 'service', status: 'fail', summary: `the ${service.kind} service ${service.name} runs files that are gone; run alp daemon install again`, details: missing }
    : { id: 'service', status: 'ok', summary: `${service.kind} runs alpd as ${service.name}` };
}

const seconds = ms => `${Math.round(ms / 1000)} s`;

/** Codes of the failures a start can stop at, and of the ones that mean another alpd is running. */
const STARTUP_CODES = new Set(['ALP_HOME_UNUSABLE', 'ALP_LOCK_FAILED', 'ALP_STARTUP_FAILED', 'ALP_IPC_LISTEN_FAILED']);
const GROUPS = [
  { id: 'persistence log', match: /^ALP_(PERSISTENCE|STATE|RECORD|TIMELINE)_/, hint: 'alpd could not read or write its state; check free space and the permissions of the state directory' },
  { id: 'ipc log', match: /^ALP_(IPC|RPC)_/, hint: 'clients had trouble talking to alpd; alp daemon restart reopens the endpoint' },
  { id: 'provider log', match: /^ALP_PROVIDER_/, hint: 'a runtime process failed or would not start; the runtime checks above say whether it is installed and logged in' },
];
const STATE_FAILURES = { ENOENT: 'is missing', EACCES: 'is not accessible to you', EPERM: 'is not accessible to you', EROFS: 'is on a read-only filesystem', ENOSPC: 'has no space left' };

/** What a failed connection to alpd's socket means, as a code the log uses too. */
function ipcFailure(error) {
  if (error?.code === 'ALP_IPC_TIMEOUT') return 'ALP_IPC_TIMEOUT';
  if (error?.code === 'ENOENT') return 'ALP_IPC_SOCKET_MISSING';
  if (error?.code === 'ECONNREFUSED') return 'ALP_IPC_REFUSED';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'ALP_IPC_DENIED';
  if (/private|owned by|ancestors|symlink/.test(error?.message ?? '')) return 'ALP_IPC_SOCKET_UNSAFE';
  return 'ALP_IPC_FAILED';
}

/** Asks a running alpd for its status; `error` says why it could not be asked. */
async function askDaemon(lock, timeoutMs) {
  let timer;
  const attempt = connect(lock.socket, { name: 'alp-doctor', version: '1' }).then(async client => {
    try { return await client.request('daemon.status'); } finally { client.close(); }
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${seconds(timeoutMs)}`), { code: 'ALP_IPC_TIMEOUT' })), timeoutMs); });
  try { return { status: await Promise.race([attempt, timeout]) }; }
  catch (error) { attempt.catch(() => {}); return { error }; }
  finally { clearTimeout(timer); }
}

/**
 * alpd as a client sees it (ALPD §67): whether its IPC endpoint answers, and whether it is ready,
 * which is more than alive: it accepts connections and its state is readable and writable now.
 */
async function daemonHealthChecks(lock, timeoutMs) {
  if (!lockAlive(lock) || lock.maintenance) return [];
  const { status, error } = await askDaemon(lock, timeoutMs);
  if (error) {
    const code = ipcFailure(error);
    // A socket that is missing right after start is still being opened.
    const starting = !lock.ready && Date.now() - Date.parse(lock.startedAt) < 60_000;
    return [{
      id: 'ipc', status: starting ? 'info' : 'fail',
      summary: `alpd (pid ${lock.pid}) is running but ${starting ? 'does not answer yet, it is still starting' : 'cannot be reached'} on ${lock.socket}: ${code}, ${error.message}`,
      details: [`code ${code}`, ...(starting ? [] : ['alp daemon restart starts it again; its work is kept and continued'])],
    }];
  }
  const checks = [{ id: 'ipc', status: 'ok', summary: `alpd answers on ${lock.socket} (protocol ${status.protocolVersion})` }];
  const health = status.health;
  if (!health) { checks.push({ id: 'readiness', status: 'info', summary: `alpd ${status.version} does not report readiness; alp daemon restart updates it` }); return checks; }
  const failing = health.checks.filter(check => !check.ok);
  checks.push(health.ready
    ? { id: 'readiness', status: 'ok', summary: 'alpd is ready: it accepts connections and reads and writes its state' }
    : {
      id: 'readiness', status: 'fail',
      summary: `alpd is alive but not ready: ${failing.map(check => check.code ?? check.id).join(', ')}`,
      details: failing.map(check => `${check.code ?? check.id}: ${check.message ?? 'failed'}`),
      hint: 'new prompts may fail until this clears; alp doctor shows the state directory below',
    });
  if (!lock.ready) checks.push({ id: 'startup', status: 'warn', summary: 'alpd answers but has not finished starting' });
  return checks;
}

/** The state directory alpd keeps sessions in, without writing to it (alpd probes its own writes). */
async function stateCheck(home) {
  const directory = path.join(home, 'state');
  const info = await lstat(directory).catch(() => undefined);
  const target = info ? directory : home;
  if (!info && !await lstat(home).then(() => true, () => false)) return { id: 'state', status: 'ok', summary: `${directory} is created when alpd first starts` };
  try { await access(target, constants.R_OK | constants.W_OK | constants.X_OK); }
  catch (error) {
    return {
      id: 'state', status: 'fail', summary: `${target} ${STATE_FAILURES[error.code] ?? `cannot be used (${error.code ?? error.message})`}: alpd cannot ${error.code === 'ENOENT' ? 'find' : 'write'} its sessions; ALP_STATE_NOT_WRITABLE`,
      details: [error.message],
    };
  }
  if (!info) return { id: 'state', status: 'ok', summary: `${directory} is created when alpd first starts` };
  const unreadable = [];
  const leftovers = [];
  let records = 0;
  for (const name of await readdir(path.join(directory, 'sessions')).catch(() => []).then(names => names.slice(0, 2000))) {
    if (name.endsWith('.tmp')) { leftovers.push(name); continue; }
    if (!name.endsWith('.json')) continue;
    records++;
    try { const record = JSON.parse(await readFile(path.join(directory, 'sessions', name), 'utf8')); if (record?.version !== 1 || typeof record.id !== 'string') unreadable.push(name); }
    catch { unreadable.push(name); }
  }
  if (unreadable.length) return {
    id: 'state', status: 'warn', summary: `${unreadable.length} of ${records} session record${records > 1 ? 's' : ''} in ${directory} cannot be read; alpd skips ${unreadable.length > 1 ? 'them' : 'it'} and ${unreadable.length > 1 ? 'those sessions are' : 'that session is'} not listed (ALP_RECORD_UNREADABLE)`,
    details: [...unreadable.slice(0, 10), 'doctor never deletes them: copy or repair the files by hand'],
  };
  return { id: 'state', status: 'ok', summary: `${directory} is readable and writable; ${records} session record${records === 1 ? '' : 's'}${leftovers.length ? `, ${leftovers.length} temporary file${leftovers.length > 1 ? 's' : ''} left by an interrupted write (alpd removes them)` : ''}` };
}

const brief = record => `${record.time} ${record.component} ${record.code ?? ''} ${record.msg}${record.sessionId ? ` [session ${record.sessionId}]` : ''}`.replace(/\s+/g, ' ').trim();

/** What alpd's own log says: where the last start stopped, and the failures logged since it was ready. */
async function logChecks(home, running) {
  const file = daemonPaths(home).log;
  let records;
  try { records = (await readLogTail(file)).filter(record => !record.legacy); }
  catch (error) { return [{ id: 'log', status: 'warn', summary: `${file} cannot be read: ${error.message}` }]; }
  if (!records.length) return [];
  const lastReady = records.findLastIndex(record => record.event === 'ready');
  const since = records.slice(lastReady + 1);
  const checks = [];
  const failure = since.findLast(record => record.level === 'error' && STARTUP_CODES.has(record.code));
  if (failure) checks.push({
    id: 'startup', status: running ? 'info' : 'fail',
    summary: `${running ? 'an attempt to start another alpd' : 'the last alpd'} failed at ${failure.time}: ${failure.code}, ${failure.msg}`,
    details: [...(failure.error ? [`${failure.error.name ?? 'Error'}${failure.error.code ? ` ${failure.error.code}` : ''}: ${failure.error.message}`] : []), `log: ${file}`],
    ...(running ? {} : { hint: 'fix the cause and run alp daemon start; its work is kept and continued' }),
  });
  for (const group of GROUPS) {
    const found = since.filter(record => (record.level === 'error' || record.level === 'warn') && group.match.test(record.code ?? ''));
    if (!found.length) continue;
    const counts = new Map();
    for (const record of found) counts.set(record.code, (counts.get(record.code) ?? 0) + 1);
    checks.push({
      id: group.id, status: 'warn',
      summary: `${found.length} problem${found.length > 1 ? 's' : ''} logged since alpd was last ready: ${[...counts].map(([code, count]) => `${code} x${count}`).join(', ')}`,
      details: [...found.slice(-5).map(brief), group.hint],
    });
  }
  return checks;
}

/** Sessions that ended in failure, from their records: what a provider failure left, with the codes the log uses. */
async function failedSessionsCheck(home) {
  const directory = path.join(home, 'state', 'sessions');
  const failed = [];
  for (const name of await readdir(directory).catch(() => []).then(names => names.slice(0, 2000))) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (record?.status === 'failed' && record.lastError) failed.push(record);
    } catch {}
  }
  if (!failed.length) return undefined;
  failed.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const recent = failed.filter(record => Date.now() - Date.parse(record.updatedAt) < 24 * 3600_000);
  return {
    id: 'failed sessions', status: recent.length ? 'warn' : 'info',
    summary: `${failed.length} session${failed.length > 1 ? 's' : ''} ended in failure${recent.length ? `, ${recent.length} in the last day` : ''}; kept, nothing is deleted`,
    details: failed.slice(0, 5).map(record => `${record.updatedAt} ${record.session?.agent ?? 'session'} ${record.id} (${record.session?.runtime ?? 'unknown runtime'}) ${record.lastError.code ?? ''} ${String(record.lastError.message).slice(0, 200)}`.replace(/\s+/g, ' ')),
  };
}

async function daemonCheck(home) {
  const paths = daemonPaths(home);
  const lock = await readLock(home);
  const exists = file => lstat(file).then(() => true, () => false);
  if (lockAlive(lock) && lock.maintenance) return { id: 'alpd', status: 'info', summary: `not running while alp ${lock.maintenance} runs (pid ${lock.pid})` };
  if (lockAlive(lock)) return { id: 'alpd', status: 'ok', summary: `running (pid ${lock.pid}, ${lock.version})${lock.ready ? '' : ', starting'}` };
  const stale = [];
  if (await exists(paths.lock)) stale.push(paths.lock);
  if (await exists(paths.socket)) stale.push(paths.socket);
  const crashed = await exists(path.join(home, 'state', 'alpd.running'));
  const after = crashed ? '; the last alpd stopped unexpectedly, and the next start continues its work' : '';
  if (!stale.length) return { id: 'alpd', status: crashed ? 'info' : 'ok', summary: `not running${after}` };
  return {
    id: 'alpd', status: 'warn', summary: `not running, and left ${stale.map(file => path.basename(file)).join(' and ')} behind${after}`,
    fix: {
      describe: `remove ${stale.join(', ')}`,
      async apply() {
        // Check again: an alpd may have started meanwhile.
        if (lockAlive(await readLock(home))) return 'skipped: alpd started meanwhile';
        for (const file of stale) await unlink(file).catch(() => {});
        return `removed ${stale.length} stale file${stale.length > 1 ? 's' : ''}`;
      },
    },
  };
}

/** Files and directories under ALP_HOME that hold logs, state or settings. */
async function privateEntries(home) {
  const entries = [home];
  for (const name of ['settings.json', 'alpd.lock', 'alpd.json', 'role-skills.json']) entries.push(path.join(home, name));
  for (const directory of ['state', 'runs', 'logs', 'boards', 'worktrees', 'copies']) {
    const full = path.join(home, directory);
    entries.push(full);
    if (directory === 'worktrees' || directory === 'copies') continue;
    for (const name of await readdir(full).catch(() => [])) entries.push(path.join(full, name));
  }
  return entries;
}

async function permissionsCheck(home) {
  // Windows files have no group/other mode bits to read or tighten; the profile's ACL keeps the home private.
  if (process.platform === 'win32') return { id: 'permissions', status: 'ok', summary: `${home} follows your Windows profile access rules` };
  const open = [];
  for (const entry of await privateEntries(home)) {
    const info = await lstat(entry).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !(info.mode & 0o077)) continue;
    open.push({ entry, mode: info.mode & 0o777, directory: info.isDirectory() });
  }
  if (!open.length) return { id: 'permissions', status: 'ok', summary: `${home} is private to you` };
  return {
    id: 'permissions', status: 'warn',
    summary: `${open.length} entr${open.length > 1 ? 'ies' : 'y'} under ${home} readable by others; they hold task briefs, results and settings`,
    details: open.map(item => `${item.mode.toString(8).padStart(4, '0')} ${item.entry}`),
    fix: {
      describe: 'remove group and other access from them',
      async apply() {
        for (const item of open) await chmod(item.entry, item.mode & 0o700).catch(() => {});
        return `tightened ${open.length} entr${open.length > 1 ? 'ies' : 'y'}`;
      },
    },
  };
}

async function userSettingsCheck(home) {
  const file = path.join(home, 'settings.json');
  try {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return { id: 'user settings', status: 'ok', summary: `none (${file})` };
    const settings = JSON.parse(text);
    validateUserSettings(settings, file);
    const warnings = settingsWarnings(settings, 'user');
    return warnings.length
      ? { id: 'user settings', status: 'warn', summary: `${file}: ${warnings.length} key${warnings.length > 1 ? 's' : ''} ALP ignores`, details: warnings }
      : { id: 'user settings', status: 'ok', summary: file };
  } catch (error) {
    return { id: 'user settings', status: 'fail', summary: `alpd ignores ${file}: ${error.message.replace(`${file}: `, '')}` };
  }
}

async function projectChecks(project, home) {
  const checks = [];
  const file = path.join(project, '.alp', 'settings.json');
  let settings;
  try {
    settings = await jsonObject(file, 'INVALID_SETTINGS');
    validateSettings(settings, file);
    const warnings = settingsWarnings(settings, 'project');
    checks.push(warnings.length
      ? { id: 'settings', status: 'warn', summary: `${file}: ${warnings.length} key${warnings.length > 1 ? 's' : ''} ALP ignores`, details: warnings }
      : { id: 'settings', status: 'ok', summary: file });
  } catch (error) {
    checks.push({ id: 'settings', status: 'fail', summary: error.message });
    return checks;
  }
  const sources = await agentSources(project, { library: home });
  const agents = [...sources.keys()].sort((a, b) => a.localeCompare(b));
  const broken = [];
  const shadows = [];
  const hooks = new Map();
  // An override replaces the whole agent, so it misses later updates to the one it replaces.
  for (const [agent, { source, overrides }] of sources) if (overrides) shadows.push(`${agent}: the ${source}'s copy replaces the ${overrides === 'builtin' ? 'built-in' : 'library'} agent`);
  for (const agent of agents) {
    try {
      const resolved = await resolveAgent(project, { agent, library: home });
      for (const hook of await loadHooks(resolved)) hooks.set(hook.path, { ...hook, agents: [...(hooks.get(hook.path)?.agents ?? []), agent] });
      for (const skill of resolved.skills) if (!skill.path.startsWith(home + path.sep)) {
        const library = path.join(home, 'skills', skill.name, 'SKILL.md');
        if (await lstat(library).then(() => true, () => false)) shadows.push(`${agent}: ${skill.name} from the project replaces the library's`);
      }
    } catch (error) { broken.push(`${agent}: ${error.message}`); }
  }
  if (!agents.length) checks.push({ id: 'agents', status: 'fail', summary: 'no agents: neither ALP\'s built-ins nor the library nor the project define one' });
  else if (broken.length) checks.push({ id: 'agents', status: 'fail', summary: `${broken.length} of ${agents.length} agents cannot start`, details: broken });
  else checks.push({ id: 'agents', status: shadows.length ? 'info' : 'ok', summary: `${agents.length} agents resolve: ${agents.join(', ')}`, ...(shadows.length ? { details: shadows } : {}) });
  if (hooks.size) checks.push(await hooksCheck(project, home, [...hooks.values()]));
  if (settings.defaultAgent && !agents.includes(settings.defaultAgent)) checks.push({ id: 'agents', status: 'fail', summary: `defaultAgent ${settings.defaultAgent} is not an agent of this project` });
  return checks;
}

/** The command a hook starts, when it is a plain program name or path: the first word of its shell command. */
const program = command => /^\s*([\w./-]+)/.exec(command)?.[1];
const SHELL_WORDS = new Set(['cd', 'test', '[', 'echo', 'exit', 'true', 'false', 'set', 'export', 'if', 'for', 'while', 'exec', 'env', 'command', 'printf', 'read', 'source', '.']);

/** Hooks the agents use: whether the project's may run, and whether their programs exist (ALPD §45). */
async function hooksCheck(project, home, hooks) {
  const missing = [];
  for (const hook of hooks) {
    const name = program(hook.command);
    if (!name || SHELL_WORDS.has(name)) continue;
    const candidates = name.includes('/') ? [path.resolve(project, name)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
    let found = false;
    for (const candidate of candidates) if (await access(candidate, constants.X_OK).then(() => true, () => false)) { found = true; break; }
    if (!found) missing.push(`${hook.name} (${hook.event}, used by ${hook.agents.join(', ')}): ${name} is not found`);
  }
  const fromProject = hooks.filter(hook => hook.project);
  const trusted = fromProject.length ? await isTrusted(home, project) : true;
  const details = [...missing, ...(!trusted ? [`not trusted yet: ${fromProject.map(hook => hook.name).join(', ')}; alpd asks the first time one runs, or run alp trust`] : [])];
  return {
    id: 'hooks', status: missing.length ? 'warn' : trusted ? 'ok' : 'info',
    summary: `${hooks.length} hook${hooks.length > 1 ? 's' : ''}${fromProject.length ? `, ${fromProject.length} from the project${trusted ? ', which the user trusts' : ', not trusted yet'}` : ''}${missing.length ? `; ${missing.length} cannot start` : ''}`,
    ...(details.length ? { details } : {}),
  };
}

/**
 * ACP providers of the library (ALPD §46): whether their commands exist, and what ALP
 * cannot do for an agent it reaches through ACP.
 */
async function providersCheck(home, env) {
  let providers;
  try { providers = await listProviders(home); } catch (error) { return { id: 'providers', status: 'fail', summary: error.message }; }
  if (!providers.length) return undefined;
  const missing = [];
  for (const provider of providers) if (!await executable(provider.command, { ...env, ...provider.env })) missing.push(`${provider.id}: ${provider.command} is not found`);
  return {
    id: 'providers', status: 'warn',
    summary: `${providers.length} ACP provider${providers.length > 1 ? 's' : ''} (${providers.map(provider => provider.id).join(', ')})${missing.length ? `; ${missing.length} cannot start` : ''}`,
    details: [...missing,
      'ALP has no sandbox around an ACP agent: it holds the session\'s mode only by answering the permission requests the agent sends, so a command the agent runs without asking runs unchecked',
      'ALP cannot steer an ACP agent mid-turn (mail waits for the turn to end), resumes its sessions only when it supports session/load, and cannot recall them or give them review copies'],
  };
}

async function librarySkillsCheck(home) {
  const file = path.join(home, 'role-skills.json');
  let roles;
  try {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return undefined;
    roles = JSON.parse(text);
  } catch (error) { return { id: 'skills', status: 'fail', summary: `${file}: ${error.message}` }; }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return { id: 'skills', status: 'fail', summary: `${file}: expected an object of role names to skill lists` };
  const missing = [];
  for (const [role, names] of Object.entries(roles)) {
    if (!Array.isArray(names)) { missing.push(`${role}: not a list`); continue; }
    for (const name of names) {
      if (typeof name !== 'string' || !await lstat(path.join(home, 'skills', name, 'SKILL.md')).then(() => true, () => false)) missing.push(`${role}: ${name}`);
    }
  }
  return missing.length
    ? { id: 'skills', status: 'warn', summary: `${file} lists ${missing.length} skill${missing.length > 1 ? 's' : ''} the library lacks; agents start without them`, details: missing }
    : { id: 'skills', status: 'ok', summary: `the library's skills exist (${file})` };
}

/** The live book alpd continues at start: entries whose project is gone can never continue. */
async function liveCheck(home, running) {
  const file = path.join(home, 'state', 'live.json');
  let entries;
  try { entries = JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
  if (!Array.isArray(entries)) return { id: 'live work', status: 'warn', summary: `${file} is not a list; alpd ignores it` };
  const gone = [];
  for (const entry of entries) {
    if (typeof entry?.project !== 'string' || !await lstat(entry.project).then(() => true, () => false)) gone.push(entry);
  }
  if (!gone.length) return { id: 'live work', status: entries.length && !running ? 'info' : 'ok', summary: entries.length ? `${entries.length} assignment${entries.length > 1 ? 's' : ''} ${running ? 'running' : 'waiting for alpd to continue'}` : 'no running assignments' };
  return {
    id: 'live work', status: 'warn',
    summary: `${gone.length} interrupted assignment${gone.length > 1 ? 's' : ''} belong to projects that no longer exist`,
    details: gone.map(entry => `${entry?.agent} ${entry?.assignmentId} in ${entry?.project}`),
    fix: running ? undefined : {
      describe: `drop them from ${file}, keeping a copy beside it`,
      async apply() {
        const current = JSON.parse(await readFile(file, 'utf8'));
        const ids = new Set(gone.map(entry => entry?.assignmentId));
        const kept = current.filter(entry => !ids.has(entry?.assignmentId));
        // What is dropped stays on disk, so a repair never loses a record.
        await writeFile(`${file}.dropped-${Date.now()}.json`, JSON.stringify(current.filter(entry => ids.has(entry?.assignmentId)), null, 2) + '\n', { mode: 0o600 });
        await writeFile(file, JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 });
        return `dropped ${current.length - kept.length}`;
      },
    },
    ...(running ? { hint: 'stop alpd to drop them' } : {}),
  };
}

/** Worktrees git lost track of, and alp/* branches: merged ones are dead weight, unmerged ones hold kept work. */
async function branchCheck(project, home, run) {
  const git = args => run('git', args, { cwd: project });
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return [];
  const checks = [];
  const worktrees = (await git(['worktree', 'list', '--porcelain'])).stdout.split('\n\n').filter(Boolean);
  const prunable = worktrees.filter(block => /^prunable/m.test(block)).map(block => block.match(/^worktree (.*)$/m)?.[1]).filter(Boolean);
  if (prunable.length) checks.push({
    id: 'worktrees', status: 'warn', summary: `git still lists ${prunable.length} worktree${prunable.length > 1 ? 's' : ''} that no longer exist`, details: prunable,
    fix: { describe: 'git worktree prune', async apply() { await git(['worktree', 'prune']); return 'pruned'; } },
  });
  const checkedOut = new Set(worktrees.map(block => block.match(/^branch refs\/heads\/(.*)$/m)?.[1]).filter(Boolean));
  let live = [];
  try { live = JSON.parse(await readFile(path.join(home, 'state', 'live.json'), 'utf8')); } catch {}
  const inUse = new Set([...checkedOut, ...(Array.isArray(live) ? live.map(entry => entry?.worktree?.branch).filter(Boolean) : [])]);
  const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/alp/'])).stdout.split('\n').filter(Boolean);
  if (!branches.length) return checks;
  const merged = new Set((await git(['branch', '--format=%(refname:short)', '--merged', 'HEAD', '--list', 'alp/*'])).stdout.split('\n').filter(Boolean));
  const spare = branches.filter(branch => merged.has(branch) && !inUse.has(branch));
  const kept = branches.filter(branch => !merged.has(branch) && !inUse.has(branch));
  if (spare.length) checks.push({
    id: 'branches', status: 'warn', summary: `${spare.length} alp/* branch${spare.length > 1 ? 'es are' : ' is'} already merged into HEAD`, details: spare,
    fix: {
      describe: `delete ${spare.length > 1 ? 'them' : 'it'} with git branch -d`,
      async apply() {
        let deleted = 0;
        for (const branch of spare) if ((await git(['branch', '-d', branch])).code === 0) deleted++;
        return `deleted ${deleted}`;
      },
    },
  });
  if (kept.length) checks.push({ id: 'branches', status: 'info', summary: `${kept.length} alp/* branch${kept.length > 1 ? 'es hold' : ' holds'} unmerged work from finished or interrupted assignments; merge or delete ${kept.length > 1 ? 'them' : 'it'} yourself`, details: kept });
  if (!spare.length && !kept.length) checks.push({ id: 'branches', status: 'ok', summary: `${branches.length} alp/* branch${branches.length > 1 ? 'es' : ''} in use` });
  return checks;
}

/** A check with every line scrubbed: a message may quote what a runtime, a file or a user wrote. */
function scrubCheck(check) {
  const clean = text => scrubText(text, { max: 1000 });
  return {
    ...check, summary: clean(check.summary),
    ...(check.details ? { details: check.details.map(clean) } : {}),
    ...(check.hint ? { hint: clean(check.hint) } : {}),
  };
}

/**
 * Runs every check. `project` is an ALP project root or undefined; `sandbox` says whether
 * Claude can sandbox Bash here (undefined when unknown); `daemonEntry` is alpd's path.
 */
export { runCommand };

/** The state's schema (ALPD §68), and a migration or a restore cut short. Reads only. */
async function schemaChecks(home) {
  let info;
  try { info = await readStateSchema(home); }
  catch (error) { return [{ id: 'schema', status: 'fail', summary: `${error.message} (ALP_${error.code ?? 'STATE_UNUSABLE'})` }]; }
  const checks = [info.schema > STATE_SCHEMA
    ? { id: 'schema', status: 'fail', summary: `state schema ${info.schema}${info.by ? ` from ${info.by}` : ''} is newer than this ALP knows (${STATE_SCHEMA}): alpd refuses to start and changes nothing in it (ALP_STATE_SCHEMA_TOO_NEW)`, hint: 'run the ALP that wrote it, or a newer one; docs/alp/data-recovery.md says more' }
    : { id: 'schema', status: info.schema < STATE_SCHEMA ? 'info' : 'ok', summary: info.fresh ? `no state yet; alpd starts it at schema ${STATE_SCHEMA}` : info.schema < STATE_SCHEMA ? `state schema ${info.schema}: alpd migrates it to ${STATE_SCHEMA} at its next start, after saving a backup in ${path.join(home, 'backups')}` : `state schema ${info.schema}` }];
  if (await lstat(migrationFile(home)).then(() => true, () => false)) checks.push({ id: 'migration', status: 'warn', summary: 'a state migration was cut short; alpd continues it at its next start, or puts the state back if it fails' });
  if (await lstat(path.join(home, 'restore-journal.json')).then(() => true, () => false)) checks.push({ id: 'restore', status: 'warn', summary: 'a restore was cut short; alpd or the next alp restore moves the earlier data back first' });
  return checks;
}

/** Checks whether directory `target` is inside directory `container`. */
function isInside(target, container) {
  const resolve = directory => {
    let current = path.resolve(directory);
    let suffix = '';
    for (;;) {
      try { return path.join(realpathSync(current), suffix); }
      catch {
        const parent = path.dirname(current);
        if (parent === current) return path.join(current, suffix);
        suffix = path.join(path.basename(current), suffix);
        current = parent;
      }
    }
  };
  const resolvedTarget = resolve(target);
  const resolvedContainer = resolve(container);
  const relative = path.relative(resolvedContainer, resolvedTarget);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Checks where ALP_HOME sits: staging and state live there (§12.6). Sandboxed sessions
 * can write the temp directory and their workspace, so staged copies inside either could
 * be modified by a sandboxed tool before alpd reads them (ALP_ATTACHMENT_STAGE_EXPOSED).
 */
async function homeLocationCheck(home, project) {
  if (process.platform === 'win32' || !home) return { id: 'home', status: 'ok', summary: home ?? '' };
  if (project && isInside(home, project)) {
    return {
      id: 'home', status: 'warn',
      summary: `ALP_HOME (${home}) is inside this project's workspace, which sandboxed sessions may write: a tool could change staged attachment copies before they are read; keep ALP_HOME outside workspaces (default ~/.alp)`,
    };
  }
  const inTmp = isInside(home, os.tmpdir()) || isInside(home, '/tmp');
  if (inTmp) {
    return {
      id: 'home', status: 'warn',
      summary: `ALP_HOME (${home}) is inside the temp directory, which sandboxed sessions may write: a tool could change staged attachment copies before they are read; keep ALP_HOME outside it (default ~/.alp)`,
    };
  }
  return { id: 'home', status: 'ok', summary: home };
}

const GIB = 1024 ** 3;
const formatSize = bytes => bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/** Entries of `directory` whose names start with `prefix`, as full paths; none when it cannot be read. */
async function entries(directory, prefix = '') {
  const names = await readdir(directory).catch(() => []);
  return names.filter(name => name.startsWith(prefix)).map(name => path.join(directory, name));
}

/**
 * Free space where ALP_HOME lives (t-2831), and what earlier runs left that takes room:
 * worktrees under ALP_HOME/worktrees and alp-* directories in the temp directory. When
 * the disk fills, alpd pauses work instead of stopping; this says so before it happens.
 * Nothing is deleted, by --fix either: a leftover may hold someone's uncommitted work.
 */
export async function diskCheck(home, { run = runCommand, env = process.env, free, tempDirs = [...new Set([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])])] } = {}) {
  let bytes = free;
  if (bytes === undefined) {
    try { const info = await statfs(home); bytes = Number(info.bavail) * Number(info.bsize); } catch {}
  }
  const worktrees = await entries(path.join(home, 'worktrees'));
  const temp = [];
  for (const directory of tempDirs) {
    for (const entry of await entries(directory, 'alp-')) {
      const info = await lstat(entry).catch(() => undefined);
      if (info?.isDirectory() && !temp.includes(realpathOr(entry))) temp.push(realpathOr(entry));
    }
  }
  /** Kilobytes du counts under the paths; undefined when du is missing, slow or fails. */
  async function size(paths) {
    if (!paths.length) return 0;
    if (process.platform === 'win32') return undefined;
    const result = await run('du', ['-sk', ...paths], { env, timeoutMs: 20_000 });
    if (result.code !== 0 && !result.stdout) return undefined;
    const total = result.stdout.split('\n').reduce((sum, line) => sum + (Number(line.split(/\s+/)[0]) || 0), 0);
    return total * 1024;
  }
  const details = [];
  for (const [label, paths] of [[`${path.join(home, 'worktrees')}`, worktrees], [`${tempDirs.map(directory => path.join(directory, 'alp-*')).join(', ')}`, temp]]) {
    if (!paths.length) continue;
    const used = await size(paths);
    details.push(`${paths.length} left in ${label}${used === undefined ? '' : `, ${formatSize(used)}`}`);
  }
  const hint = details.length ? 'ALP deletes none of these: some may belong to running assignments or hold uncommitted work. Remove those you no longer need (git worktree remove, or rm -rf).' : undefined;
  const where = bytes === undefined ? 'free space unknown' : `${formatSize(bytes)} free`;
  // Leftovers are listed, not judged: some may be live.
  const status = bytes !== undefined && bytes < 2 * GIB ? 'warn' : 'ok';
  const summary = bytes !== undefined && bytes < 2 * GIB
    ? `${where} where ALP_HOME lives; when the disk is full, alpd pauses all work until space returns`
    : `${where} where ALP_HOME lives`;
  return { id: 'disk', status, summary, ...(details.length ? { details } : {}), ...(hint ? { hint } : {}) };
}

function realpathOr(file) {
  try { return realpathSync(file); } catch { return file; }
}

export async function diagnose({ home, project, env = process.env, run = runCommand, sandbox, daemonEntry, timeoutMs = 3000 } = {}) {
  const checks = [];
  if (daemonEntry) {
    checks.push(await lstat(daemonEntry).then(() => ({ id: 'build', status: 'ok', summary: daemonEntry }), () => ({ id: 'build', status: 'fail', summary: `alpd is not built (${daemonEntry}); run npm run build` })));
  }
  checks.push(...await runtimeChecks({ env, run }));
  checks.push(await homeLocationCheck(home, project));
  if (home) checks.push(await diskCheck(home, { run, env }));
  const daemon = await daemonCheck(home);
  checks.push(daemon);
  const service = await serviceCheck(home, env);
  if (service) checks.push(service);
  const running = daemon.status === 'ok' && daemon.summary.startsWith('running');
  checks.push(...await daemonHealthChecks(await readLock(home), timeoutMs));
  checks.push(await stateCheck(home));
  const schema = await schemaChecks(home);
  checks.push(...schema);
  // State an ALP cannot read is left alone, by --fix too.
  const unreadable = schema.some(check => check.id === 'schema' && check.status === 'fail');
  checks.push(...await logChecks(home, running));
  const failedSessions = await failedSessionsCheck(home);
  if (failedSessions) checks.push(failedSessions);
  if (sandbox !== undefined) checks.push(sandbox
    ? { id: 'sandbox', status: 'ok', summary: 'Claude sessions run Bash in an OS sandbox that holds their mode' }
    : { id: 'sandbox', status: 'warn', summary: `no Bash sandbox for Claude (${process.platform === 'linux' ? 'install bubblewrap and socat' : 'Seatbelt is missing'}): read-only Claude agents rely on their permission rules alone, and review copies on Claude cannot start` });
  checks.push(await permissionsCheck(home));
  checks.push(await userSettingsCheck(home));
  const skills = await librarySkillsCheck(home);
  if (skills) checks.push(skills);
  const providers = await providersCheck(home, env);
  if (providers) checks.push(providers);
  const live = await liveCheck(home, running);
  if (live && unreadable) delete live.fix;
  if (live) checks.push(live);
  if (project) {
    checks.push(...await projectChecks(project, home));
    checks.push(...await branchCheck(project, home, run));
  }
  return checks.map(scrubCheck);
}

/** Applies the fixes of the given checks in order; returns what each did. */
export async function repair(checks) {
  const done = [];
  for (const check of checks) {
    if (!check.fix) continue;
    try { done.push({ id: check.id, result: await check.fix.apply() }); }
    catch (error) { done.push({ id: check.id, result: `failed: ${error.message}` }); }
  }
  return done;
}
