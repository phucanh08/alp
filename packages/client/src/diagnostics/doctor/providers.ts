import { access, constants, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, CommandRunner } from '../../_shared/command.ts';
import { listProviders } from '@anhlp/alp-core/providers';
import type { Provider } from '@anhlp/alp-core/providers';
import type { DoctorCheck } from './types.ts';

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** The executable `command` names, as a spawn without a shell would find it (on Windows that adds .exe and .com). */
async function executable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const names = process.platform === 'win32' ? [command, `${command}.exe`, `${command}.com`] : [command];
  const candidates = path.isAbsolute(command) ? names : (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name)));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue; return candidate; } catch {}
  }
  return undefined;
}

/** How to tell whether each native runtime is logged in. */
const RUNTIMES: Array<{ kind: string; command?: string; variable: string; login: string[]; hint: string; loggedIn: (result: CommandResult) => boolean }> = [
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

export async function runtimeChecks({ env, run }: { env: NodeJS.ProcessEnv; run: CommandRunner }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
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

/**
 * ACP providers of the library (ALPD §46): whether their commands exist, and what ALP
 * cannot do for an agent it reaches through ACP.
 */
export async function providersCheck(home: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck | undefined> {
  let providers: Provider[];
  try { providers = await listProviders(home); } catch (error) { return { id: 'providers', status: 'fail', summary: (error as Error).message }; }
  if (!providers.length) return undefined;
  const missing: string[] = [];
  for (const provider of providers) if (!await executable(provider.command, { ...env, ...provider.env })) missing.push(`${provider.id}: ${provider.command} is not found`);
  return {
    id: 'providers', status: 'warn',
    summary: `${providers.length} ACP provider${providers.length > 1 ? 's' : ''} (${providers.map(provider => provider.id).join(', ')})${missing.length ? `; ${missing.length} cannot start` : ''}`,
    details: [...missing,
      'ALP has no sandbox around an ACP agent: it holds the session\'s mode only by answering the permission requests the agent sends, so a command the agent runs without asking runs unchecked',
      'ALP cannot steer an ACP agent mid-turn (mail waits for the turn to end), resumes its sessions only when it supports session/load, and cannot recall them or give them review copies'],
  };
}
