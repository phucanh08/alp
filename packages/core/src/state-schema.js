import { readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { writeAtomic } from './atomic.js';

/**
 * The version of alpd's durable state in $ALP_HOME/state (plans/reference/ALPD.md §68).
 * `state/schema.json` names it; a state directory without one holds schema 1, the format
 * every ALP before 0.11 wrote. An ALP that finds a newer schema than it knows refuses to
 * open the state and changes nothing in it; an older one is migrated forward at start.
 *
 * 1: session records, receipts and timelines as of ALPD §66; timeline lines may lack a cursor.
 * 2: every timeline line carries its cursor.
 */
export const STATE_SCHEMA = 2;
export const OLDEST_STATE_SCHEMA = 1;

export const stateDir = home => path.join(home, 'state');
export const schemaFile = home => path.join(stateDir(home), 'schema.json');
export const migrationFile = home => path.join(stateDir(home), 'migration.json');

/** Directories whose entries mean the state holds data, so a missing marker means schema 1, not a fresh home. */
const DATA = ['sessions', 'timeline', 'receipts'];

/**
 * What the state directory says about its schema. `fresh` when it holds no data and no marker.
 * An unreadable marker is an error: ALP does not guess which format the data is in.
 * @param {string} home
 * @returns {Promise<{ schema: number, fresh: boolean, marked: boolean, by?: string }>}
 */
export async function readStateSchema(home) {
  let text;
  try { text = await readFile(schemaFile(home), 'utf8'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    for (const name of DATA) {
      const entries = await readdir(path.join(stateDir(home), name)).catch(error => { if (error?.code === 'ENOENT') return []; throw error; });
      if (entries.some(entry => !entry.endsWith('.tmp'))) return { schema: 1, fresh: false, marked: false };
    }
    return { schema: STATE_SCHEMA, fresh: true, marked: false };
  }
  let marker;
  try { marker = JSON.parse(text); } catch {}
  if (!marker || !Number.isSafeInteger(marker.schema) || marker.schema < 1) {
    throw new AlpError('STATE_SCHEMA_UNREADABLE', `${schemaFile(home)} does not name a state schema; ALP does not open state whose format it cannot tell. Restore a backup, or put back the file`);
  }
  return { schema: marker.schema, fresh: false, marked: true, ...(typeof marker.by === 'string' ? { by: marker.by } : {}) };
}

/** Refuses state written in a schema this ALP does not know, before anything touches it. */
export function assertStateSupported(info, home) {
  if (info.schema <= STATE_SCHEMA) return info;
  throw new AlpError('STATE_SCHEMA_TOO_NEW', `${stateDir(home)} holds state schema ${info.schema}${info.by ? `, written by ${info.by}` : ''}; this ALP knows schema ${STATE_SCHEMA} at most and leaves it untouched. Run that ALP version or a newer one, or replace it with a backup made for this version: alp restore FILE --replace-newer (docs/alp/data-recovery.md)`);
}

/** Records the schema the state is now in; written atomically. */
export async function writeStateSchema(home, schema, by) {
  await mkdir(stateDir(home), { recursive: true, mode: 0o700 });
  await writeAtomic(schemaFile(home), JSON.stringify({ schema, by, at: new Date().toISOString() }) + '\n');
}
