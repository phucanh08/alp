import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { writeAtomic } from './atomic.js';
import { STATE_SCHEMA, assertStateSupported, migrationFile, readStateSchema, stateDir, writeStateSchema } from './state-schema.js';
import { STATE_UNITS, automaticBackup, restoreBackup } from './backup.js';

/**
 * Versioned migrations of alpd's state (plans/reference/ALPD.md §68). Each step moves the
 * state from one schema to the next and is idempotent: run again over its own partial or
 * complete result it writes the same files. Before a step, the state is saved to a backup
 * and `state/migration.json` names it. Policy:
 *
 * - interrupted (a crash, a kill, a power cut): the next start finds the journal and runs
 *   the step again over what it left, with the same backup;
 * - failed (the step threw): the state is restored from that backup, the journal removed,
 *   and the start fails with STATE_MIGRATION_FAILED; the backup stays.
 *
 * The schema marker is written only after a step completed, and the journal removed last.
 */

/**
 * Schema 1 → 2: every timeline line gets the cursor the store already gives it when reading
 * (a line without a larger cursor than the line before is numbered one past it). Lines that
 * do not parse are kept as they are; the store skips them, as before.
 */
async function timelineCursors(home) {
  const directory = path.join(stateDir(home), 'timeline');
  const names = await readdir(directory).catch(error => { if (error?.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(name => name.endsWith('.jsonl'))) {
    const file = path.join(directory, name);
    const lines = [];
    let cursor = 0;
    let changed = false;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line) continue;
      let envelope;
      try { envelope = JSON.parse(line); } catch { lines.push(line); continue; }
      cursor = typeof envelope?.cursor === 'number' && envelope.cursor > cursor ? envelope.cursor : cursor + 1;
      if (envelope?.cursor === cursor) { lines.push(line); continue; }
      lines.push(JSON.stringify({ ...envelope, cursor }));
      changed = true;
    }
    if (changed) await writeAtomic(file, lines.map(line => `${line}\n`).join(''));
  }
}

/** @type {Array<{ from: number, to: number, name: string, run(home: string): Promise<void> }>} */
export const MIGRATIONS = [
  { from: 1, to: 2, name: 'timeline-cursors', run: timelineCursors },
];

async function readJournal(home) {
  try { return JSON.parse(await readFile(migrationFile(home), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    // A journal cut short says only that a migration was under way: start the step over.
    return {};
  }
}

const exists = file => stat(file).then(() => true, () => false);

/**
 * Brings the state to `target` (the current schema), or refuses a newer one without touching it.
 * Returns the steps it ran; `resumed` marks a step an interruption had left unfinished.
 * @param {string} home
 * @param {{ by?: string, migrations?: typeof MIGRATIONS, target?: number, log?: { info(message: string, fields?: object): void, warn(message: string, fields?: object): void } }} [options]
 */
export async function migrateState(home, { by = 'alp', migrations = MIGRATIONS, target = STATE_SCHEMA, log } = {}) {
  const info = assertStateSupported(await readStateSchema(home), home);
  let journal = await readJournal(home);
  if (journal && Number.isSafeInteger(journal.to) && journal.to <= info.schema) {
    // The step completed and only the journal's removal was cut off.
    await rm(migrationFile(home), { force: true });
    journal = undefined;
  }
  if (info.fresh && !journal) {
    await writeStateSchema(home, target, by);
    return { from: target, to: target, steps: [] };
  }
  let schema = info.schema;
  const steps = [];
  while (schema < target) {
    const step = migrations.find(candidate => candidate.from === schema);
    if (!step) throw new AlpError('STATE_MIGRATION_MISSING', `ALP has no migration from state schema ${schema}; the state was not changed`);
    const resumed = journal?.to === step.to && typeof journal.backup === 'string' && await exists(journal.backup);
    const backup = resumed ? journal.backup : await automaticBackup(home, `pre-migrate-v${step.from}-v${step.to}`, { units: STATE_UNITS, by });
    if (!resumed) await writeAtomic(migrationFile(home), JSON.stringify({ from: step.from, to: step.to, name: step.name, backup, by, startedAt: new Date().toISOString() }) + '\n');
    log?.info(`${resumed ? 'continuing' : 'running'} state migration ${step.name} (schema ${step.from} → ${step.to}); backup ${backup}`, { code: 'ALP_STATE_MIGRATING', from: step.from, to: step.to, migration: step.name, resumed });
    try {
      await step.run(home);
    } catch (error) {
      try {
        await restoreBackup({ home, file: backup, projects: false, safety: false, clearLive: false, by });
      } catch (rollback) {
        // The journal stays: the next start runs the step again over what is there.
        throw new AlpError('STATE_MIGRATION_ROLLBACK_FAILED', `state migration ${step.name} failed (${error?.message ?? error}) and putting the state back from ${backup} failed too (${rollback?.message ?? rollback}); the next start tries the migration again. See docs/alp/data-recovery.md`, { cause: error });
      }
      await rm(migrationFile(home), { force: true });
      throw new AlpError('STATE_MIGRATION_FAILED', `state migration ${step.name} (schema ${step.from} → ${step.to}) failed: ${error?.message ?? error}; the state was put back from ${backup} and is unchanged. See docs/alp/data-recovery.md`, { cause: error });
    }
    await writeStateSchema(home, step.to, by);
    await rm(migrationFile(home), { force: true });
    steps.push({ name: step.name, from: step.from, to: step.to, backup, resumed });
    schema = step.to;
    journal = undefined;
  }
  if (!info.marked && !steps.length) await writeStateSchema(home, schema, by);
  return { from: info.schema, to: schema, steps };
}
