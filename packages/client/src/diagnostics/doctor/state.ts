import { access, constants, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_SCHEMA, migrationFile, readStateSchema } from '@anhlp/alp-core/state-schema';
import type { StateSchemaInfo } from '@anhlp/alp-core/state-schema';
import type { DoctorCheck } from './types.ts';

const STATE_FAILURES: Record<string, string> = { ENOENT: 'is missing', EACCES: 'is not accessible to you', EPERM: 'is not accessible to you', EROFS: 'is on a read-only filesystem', ENOSPC: 'has no space left' };

/** The state directory alpd keeps sessions in, without writing to it (alpd probes its own writes). */
export async function stateCheck(home: string): Promise<DoctorCheck> {
  const directory = path.join(home, 'state');
  const info = await lstat(directory).catch(() => undefined);
  const target = info ? directory : home;
  if (!info && !await lstat(home).then(() => true, () => false)) return { id: 'state', status: 'ok', summary: `${directory} is created when alpd first starts` };
  try { await access(target, constants.R_OK | constants.W_OK | constants.X_OK); }
  catch (error) {
    return {
      id: 'state', status: 'fail', summary: `${target} ${STATE_FAILURES[(error as NodeJS.ErrnoException).code!] ?? `cannot be used (${(error as NodeJS.ErrnoException).code ?? (error as NodeJS.ErrnoException).message})`}: alpd cannot ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'find' : 'write'} its sessions; ALP_STATE_NOT_WRITABLE`,
      details: [(error as NodeJS.ErrnoException).message],
    };
  }
  if (!info) return { id: 'state', status: 'ok', summary: `${directory} is created when alpd first starts` };
  const unreadable: string[] = [];
  const leftovers: string[] = [];
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

/** Sessions that ended in failure, from their records: what a provider failure left, with the codes the log uses. */
export async function failedSessionsCheck(home: string): Promise<DoctorCheck | undefined> {
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

/** The live book alpd continues at start: entries whose project is gone can never continue. */
export async function liveCheck(home: string, running: boolean): Promise<DoctorCheck | undefined> {
  const file = path.join(home, 'state', 'live.json');
  let entries;
  try { entries = JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
  if (!Array.isArray(entries)) return { id: 'live work', status: 'warn', summary: `${file} is not a list; alpd ignores it` };
  const gone: Array<{ project?: unknown; agent?: string; assignmentId?: string } | null | undefined> = [];
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
        const current: Array<{ assignmentId?: string } | null | undefined> = JSON.parse(await readFile(file, 'utf8'));
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

/** The state's schema (ALPD §68), and a migration or a restore cut short. Reads only. */
export async function schemaChecks(home: string): Promise<DoctorCheck[]> {
  let info: StateSchemaInfo;
  try { info = await readStateSchema(home); }
  catch (error) { return [{ id: 'schema', status: 'fail', summary: `${(error as NodeJS.ErrnoException).message} (ALP_${(error as NodeJS.ErrnoException).code ?? 'STATE_UNUSABLE'})` }]; }
  const checks: DoctorCheck[] = [info.schema > STATE_SCHEMA
    ? { id: 'schema', status: 'fail', summary: `state schema ${info.schema}${info.by ? ` from ${info.by}` : ''} is newer than this ALP knows (${STATE_SCHEMA}): alpd refuses to start and changes nothing in it (ALP_STATE_SCHEMA_TOO_NEW)`, hint: 'run the ALP that wrote it, or a newer one; docs/alp/data-recovery.md says more' }
    : { id: 'schema', status: info.schema < STATE_SCHEMA ? 'info' : 'ok', summary: info.fresh ? `no state yet; alpd starts it at schema ${STATE_SCHEMA}` : info.schema < STATE_SCHEMA ? `state schema ${info.schema}: alpd migrates it to ${STATE_SCHEMA} at its next start, after saving a backup in ${path.join(home, 'backups')}` : `state schema ${info.schema}` }];
  if (await lstat(migrationFile(home)).then(() => true, () => false)) checks.push({ id: 'migration', status: 'warn', summary: 'a state migration was cut short; alpd continues it at its next start, or puts the state back if it fails' });
  if (await lstat(path.join(home, 'restore-journal.json')).then(() => true, () => false)) checks.push({ id: 'restore', status: 'warn', summary: 'a restore was cut short; alpd or the next alp restore moves the earlier data back first' });
  return checks;
}
