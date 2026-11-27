import { lstat } from 'node:fs/promises';
import { runCommand } from '../_shared/command.ts';
import { readLock } from '../index.ts';
import { scrubText } from '@anhlp/alp-core/log';
import type { DiagnoseOptions, DoctorCheck } from './doctor/types.ts';
import { daemonCheck, daemonHealthChecks, logChecks, serviceCheck } from './doctor/alpd.ts';
import { diskCheck } from './doctor/disk.ts';
import { homeLocationCheck, permissionsCheck } from './doctor/home.ts';
import { librarySkillsCheck, skillFormatCheck, userSettingsCheck } from './doctor/library.ts';
import { branchCheck, projectChecks } from './doctor/project.ts';
import { providersCheck, runtimeChecks } from './doctor/providers.ts';
import { failedSessionsCheck, liveCheck, schemaChecks, stateCheck } from './doctor/state.ts';

export type { CommandResult, CommandRunner } from '../_shared/command.ts';
export type { DiagnoseOptions, DiskCheckOptions, DoctorCheck, Leftover, LeftoverState } from './doctor/types.ts';
export { LEFTOVER_STATES, printable, shellQuote } from './doctor/leftovers.ts';
export { diskCheck };

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

/** A check with every line scrubbed: a message may quote what a runtime, a file or a user wrote. */
function scrubCheck(check: DoctorCheck): DoctorCheck {
  const clean = (text: string) => scrubText(text, { max: 1000 });
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

export async function diagnose({ home, project, env = process.env, run = runCommand, sandbox, daemonEntry, timeoutMs = 3000 }: DiagnoseOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (daemonEntry) {
    checks.push(await lstat(daemonEntry).then(() => ({ id: 'build', status: 'ok', summary: daemonEntry }), () => ({ id: 'build', status: 'fail', summary: `alpd is not built (${daemonEntry}); run npm run build` })));
  }
  checks.push(...await runtimeChecks({ env, run }));
  checks.push(await homeLocationCheck(home, project));
  if (home) checks.push(await diskCheck(home, { run, env }));
  const daemon = await daemonCheck(home!);
  checks.push(daemon);
  const service = await serviceCheck(home!, env);
  if (service) checks.push(service);
  const running = daemon.status === 'ok' && daemon.summary.startsWith('running');
  checks.push(...await daemonHealthChecks(await readLock(home!), timeoutMs));
  checks.push(await stateCheck(home!));
  const schema = await schemaChecks(home!);
  checks.push(...schema);
  // State an ALP cannot read is left alone, by --fix too.
  const unreadable = schema.some(check => check.id === 'schema' && check.status === 'fail');
  checks.push(...await logChecks(home!, running));
  const failedSessions = await failedSessionsCheck(home!);
  if (failedSessions) checks.push(failedSessions);
  if (sandbox !== undefined) checks.push(sandbox
    ? { id: 'sandbox', status: 'ok', summary: 'Claude sessions run Bash in an OS sandbox that holds their mode' }
    : { id: 'sandbox', status: 'warn', summary: `no Bash sandbox for Claude (${process.platform === 'linux' ? 'install bubblewrap and socat' : 'Seatbelt is missing'}): read-only Claude agents rely on their permission rules alone, and review copies on Claude cannot start` });
  checks.push(await permissionsCheck(home!));
  checks.push(await userSettingsCheck(home!));
  const skills = await librarySkillsCheck(home!);
  if (skills) checks.push(skills);
  const skillFormat = await skillFormatCheck(home!);
  if (skillFormat) checks.push(skillFormat);
  const providers = await providersCheck(home!, env);
  if (providers) checks.push(providers);
  const live = await liveCheck(home!, running);
  if (live && unreadable) delete live.fix;
  if (live) checks.push(live);
  if (project) {
    checks.push(...await projectChecks(project, home!));
    checks.push(...await branchCheck(project, home!, run));
  }
  return checks.map(scrubCheck);
}

/** Applies the fixes of the given checks in order; returns what each did. */
export async function repair(checks: DoctorCheck[]): Promise<Array<{ id: string; result: string }>> {
  const done: Array<{ id: string; result: string }> = [];
  for (const check of checks) {
    if (!check.fix) continue;
    try { done.push({ id: check.id, result: await check.fix.apply() }); }
    catch (error) { done.push({ id: check.id, result: `failed: ${(error as Error).message}` }); }
  }
  return done;
}
