import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rm, rmdir, stat, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { AlpError } from './errors.js';
import { moveFile, writeAtomic } from './atomic.js';
import { STATE_SCHEMA, assertStateSupported, readStateSchema } from './state-schema.js';
import { withTaskLock } from './tasks.js';

/**
 * Backups of ALP's data and their restore (plans/reference/ALPD.md §68).
 *
 * A backup is one gzip file of JSON lines: a header naming the units it holds, one entry per
 * directory, link and file (file content in base64 chunks with its size and sha256), and an
 * end line with the count and a sha256 over every line before it. A unit is a file or a
 * directory ALP owns, recorded as present or absent; a restore makes each unit match the
 * backup exactly. What is not a unit (logs, worktrees, the lock, live work, secrets of the
 * relay) is never backed up and never touched by a restore.
 *
 * Restore validates the whole backup while it extracts it into staging directories beside
 * the targets; a corrupt, cut-short or unsupported backup is refused before anything is
 * replaced. Then a journal ($ALP_HOME/restore-journal.json) lists every swap, the current
 * data is moved aside, the staged data moved in, and the journal marked committed. A
 * restore that fails, or whose process dies, before the commit is rolled back by the next
 * restore or alpd start; one past the commit is finished. Before swapping, the current data
 * is saved to an automatic backup, so a completed restore can be undone too.
 */

export const BACKUP_FORMAT = 1;
export const BACKUP_EXTENSION = '.alpbackup';

/** alpd's state: sessions, their timelines and receipts, and the runtime's durable state. */
export const STATE_UNITS = ['state/schema.json', 'state/sessions', 'state/timeline', 'state/receipts', 'state/recall.json', 'state/pause.json', 'state/trust.json', 'state/web-workspaces.json'];
/**
 * Live work (running assignments alpd continues after a restart) and the journal of an
 * unfinished migration are never backed up: a restore of the state removes them, so restored
 * sessions never continue work of another time and no migration resumes over restored data.
 */
export const CLEARED_UNITS = ['state/live.json', 'state/migration.json'];
/** Everything a backup of $ALP_HOME holds: the state, the user's settings and library, boards and assignment logs. */
export const HOME_UNITS = [
  ...STATE_UNITS,
  'settings.json', 'library.json', 'role-skills.json', 'lessons.md',
  'agents', 'skills', 'teams', 'hooks', 'mcp', 'providers', 'formulas',
  'boards', 'runs',
];
/** A project's ALP files: instructions, settings, its library layer and its tasks. */
export const PROJECT_UNITS = ['ALP.md', '.alp/settings.json', '.alp/lessons.md', '.alp/tasks', '.alp/agents', '.alp/skills', '.alp/teams', '.alp/hooks', '.alp/mcp', '.alp/formulas'];

const CHUNK = 1024 * 1024;
const AUTOMATIC_KEEP = 5;
const JOURNAL = 'restore-journal.json';
const RESTORED = path.join('state', 'restored.json');
/** Never copied out of a unit: temporary files, the task lock, and what an interrupted restore left. */
const transient = name => name.endsWith('.tmp') || name === '.lock' || /\.pre-restore-[0-9a-f]+$/.test(name) || /^\.restore-[0-9a-f]+$/.test(name);

export const backupsDir = home => path.join(home, 'backups');
const journalFile = home => path.join(home, JOURNAL);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const exists = file => lstat(file).then(() => true, () => false);
const invalid = (message, options) => new AlpError('BACKUP_INVALID', message, options);

/** A unit path or an entry path inside one: relative, forward slashes, no `..`, no empty parts. */
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 4096 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Session ids and project roots the state's records name, read without the store. */
async function sessionRecords(home) {
  const directory = path.join(home, 'state', 'sessions');
  const records = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    try { records.push(JSON.parse(await readFile(path.join(directory, name), 'utf8'))); } catch {}
  }
  return records;
}

/** Project roots of the recorded sessions that still exist and hold ALP files. */
export async function knownProjects(home) {
  const roots = new Set();
  for (const record of await sessionRecords(home)) {
    const root = record?.session?.projectRoot ?? record?.spec?.cwd;
    if (typeof root === 'string' && path.isAbsolute(root)) roots.add(path.resolve(root));
  }
  const found = [];
  for (const root of [...roots].sort()) if (await exists(path.join(root, '.alp'))) found.push(root);
  return found;
}

/** Native threads the sessions resume from: data the provider keeps, which ALP cannot back up. */
async function externalReferences(home) {
  const references = [];
  for (const record of await sessionRecords(home)) {
    const session = record?.session;
    if (session?.threadId) references.push({ sessionId: record.id, runtime: session.runtime, threadId: session.threadId, projectRoot: session.projectRoot });
  }
  return references;
}

/** Walks one unit; yields its entries. Symbolic links are recorded, never followed. */
async function* unitEntries(base, unit) {
  const full = path.join(base, unit);
  const info = await lstat(full).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
  if (!info) return;
  async function* walk(relative, info) {
    const file = path.join(base, relative);
    if (info.isSymbolicLink()) yield { t: 'link', path: relative, target: await readlink(file) };
    else if (info.isDirectory()) {
      yield { t: 'dir', path: relative, mode: info.mode & 0o777 };
      for (const name of (await readdir(file)).sort()) {
        if (transient(name)) continue;
        const child = await lstat(path.join(file, name)).catch(() => undefined);
        if (child) yield* walk(`${relative}/${name}`, child);
      }
    } else if (info.isFile()) yield { t: 'file', path: relative, mode: info.mode & 0o777, file };
  }
  yield* walk(unit, info);
}

async function unitKind(base, unit) {
  const info = await lstat(path.join(base, unit)).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
  return !info ? 'absent' : info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file';
}

/**
 * Writes a backup of `home`'s units and of each project's units to `out`. The caller holds
 * whatever keeps writers away (alpd stopped, its lock taken); each project's tasks are read
 * under the task lock. The file appears only once it is complete.
 * @param {{ home: string, out: string, units?: string[], projects?: string[], by?: string, kind?: string }} options
 */
export async function createBackup({ home, out, units = HOME_UNITS, projects = [], by = 'alp', kind = 'manual' }) {
  // Each project's tasks stay locked for the whole backup, so the backup holds one moment of them.
  return holdTaskLocks(projects.map(root => path.resolve(root)), () => writeBackup({ home, out, units, projects, by, kind }));
}

async function writeBackup({ home, out, units, projects, by, kind }) {
  const withState = units.some(unit => unit.startsWith('state/'));
  // The schema the state is in; a state of unknown schema is still backed up, as such.
  const stateSchema = withState ? await readStateSchema(home).then(info => info.schema, () => null) : null;
  const header = {
    t: 'header', format: 'alp-backup', version: BACKUP_FORMAT, kind, by, createdAt: new Date().toISOString(), home,
    stateSchema,
    units: await Promise.all(units.map(async unit => ({ path: unit, kind: await unitKind(home, unit) }))),
    projects: await Promise.all(projects.map(async root => ({ root: path.resolve(root), units: await Promise.all(PROJECT_UNITS.map(async unit => ({ path: unit, kind: await unitKind(root, unit) }))) }))),
    external: withState ? await externalReferences(home) : [],
  };
  const digest = createHash('sha256');
  const summary = { file: out, files: 0, bytes: 0, projects: header.projects.map(project => project.root), stateSchema, sessions: 0, tasks: 0 };
  const line = record => { const text = `${JSON.stringify(record)}\n`; digest.update(text); return text; };

  async function* area(name, base, unitList) {
    for (const { path: unit, kind } of unitList) {
      if (kind === 'absent') continue;
      for await (const entry of unitEntries(base, unit)) {
        if (entry.t !== 'file') { yield line({ ...entry, area: name }); continue; }
        const content = await readFile(entry.file);
        summary.files++;
        summary.bytes += content.length;
        if (name === 'home' && /^state\/sessions\/[^/]+\.json$/.test(entry.path)) summary.sessions++;
        if (name !== 'home' && /^\.alp\/tasks\/[^/]+\.json$/.test(entry.path)) summary.tasks++;
        const chunks = Math.max(1, Math.ceil(content.length / CHUNK));
        yield line({ t: 'file', area: name, path: entry.path, mode: entry.mode, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), chunks });
        for (let index = 0; index < chunks; index++) yield line({ t: 'data', b: content.subarray(index * CHUNK, (index + 1) * CHUNK).toString('base64') });
      }
    }
  }

  async function* lines() {
    yield line(header);
    yield* area('home', home, header.units);
    for (const [index, project] of header.projects.entries()) yield* area(`project:${index}`, project.root, project.units);
    yield `${JSON.stringify({ t: 'end', files: summary.files, bytes: summary.bytes, sha256: digest.digest('hex') })}\n`;
  }

  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  const partial = `${out}.${randomBytes(4).toString('hex')}.partial`;
  try {
    await pipeline(Readable.from(lines()), createGzip(), createWriteStream(partial, { mode: 0o600 }));
    await moveFile(partial, out);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
  return summary;
}

/** An automatic backup in $ALP_HOME/backups (before a migration or a restore); only the newest few of a kind are kept. */
export async function automaticBackup(home, kind, { units = HOME_UNITS, projects = [], by } = {}) {
  const directory = backupsDir(home);
  const out = path.join(directory, `${kind}-${stamp()}-${randomBytes(2).toString('hex')}${BACKUP_EXTENSION}`);
  await createBackup({ home, out, units, projects, by, kind });
  const prefix = `${kind}-`;
  const same = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith(BACKUP_EXTENSION)).sort();
  for (const name of same.slice(0, Math.max(0, same.length - AUTOMATIC_KEEP))) await rm(path.join(directory, name), { force: true });
  return out;
}

/**
 * Reads a backup line by line, checking each line, each file's size and sha256 and the end
 * line, and hands each verified entry to `visit`. Throws BACKUP_INVALID or BACKUP_UNSUPPORTED.
 */
async function readBackup(file, { onHeader, visit }) {
  if (!await stat(file).then(info => info.isFile(), () => false)) throw new AlpError('BACKUP_NOT_FOUND', `${file} is not a backup file`);
  const digest = createHash('sha256');
  let header;
  let end;
  let pending; // the file entry whose data lines are being read
  let files = 0;
  let bytes = 0;
  let lineNumber = 0;
  const written = new Map(); // area → paths and links seen
  async function take(text) {
    lineNumber++;
    if (end) throw invalid(`line ${lineNumber} follows the end of the backup`);
    let record;
    try { record = JSON.parse(text); } catch { throw invalid(`line ${lineNumber} is not JSON`); }
    if (record?.t === 'end') { end = record; return; }
    digest.update(`${text}\n`);
    if (!header) {
      if (record?.t !== 'header' || record.format !== 'alp-backup') throw invalid('it does not start with an ALP backup header');
      if (record.version !== BACKUP_FORMAT) throw new AlpError('BACKUP_UNSUPPORTED', `backup format ${record.version} is not one this ALP reads (${BACKUP_FORMAT}); restore it with the ALP that made it, or a newer one`);
      if (record.stateSchema !== null && record.stateSchema !== undefined && !(Number.isSafeInteger(record.stateSchema) && record.stateSchema >= 1)) throw invalid('its header names no valid state schema');
      if (Number.isSafeInteger(record.stateSchema) && record.stateSchema > STATE_SCHEMA) throw new AlpError('BACKUP_SCHEMA_TOO_NEW', `the backup holds state schema ${record.stateSchema}${record.by ? ` from ${record.by}` : ''}; this ALP knows schema ${STATE_SCHEMA} at most. Restore it with that ALP version or a newer one`);
      if (!Array.isArray(record.units) || !Array.isArray(record.projects) || ![...record.units, ...record.projects.flatMap(project => project?.units ?? [])].every(unit => safeRelative(unit?.path) && ['file', 'dir', 'link', 'absent'].includes(unit.kind))) throw invalid('its header lists units ALP cannot use');
      if (!record.projects.every(project => typeof project?.root === 'string' && path.isAbsolute(project.root) && Array.isArray(project.units))) throw invalid('its header lists projects without an absolute root');
      // Each unit once, none inside another: a restore swaps every unit on its own.
      for (const list of [record.units, ...record.projects.map(project => project.units)]) {
        const paths = list.map(unit => unit.path);
        if (paths.some((one, index) => paths.some((other, at) => at !== index && (one === other || one.startsWith(`${other}/`))))) throw invalid('its header lists a unit twice, or one inside another');
      }
      header = record;
      await onHeader?.(header);
      return;
    }
    if (pending) {
      if (record?.t !== 'data' || typeof record.b !== 'string') throw invalid(`${pending.entry.path} is cut short`);
      const chunk = Buffer.from(record.b, 'base64');
      pending.hash.update(chunk);
      pending.size += chunk.length;
      await pending.write?.(chunk);
      if (--pending.left > 0) return;
      const done = pending;
      pending = undefined;
      await done.close();
      return;
    }
    const area = record?.area;
    const units = area === 'home' ? header.units : /^project:\d+$/.test(area ?? '') ? header.projects[Number(area.slice(8))]?.units : undefined;
    if (!units) throw invalid(`line ${lineNumber} belongs to no area of the backup`);
    if (!safeRelative(record.path)) throw invalid(`line ${lineNumber} names an unsafe path`);
    const unit = units.find(candidate => record.path === candidate.path || record.path.startsWith(`${candidate.path}/`));
    if (!unit || unit.kind === 'absent' || (record.path !== unit.path && unit.kind !== 'dir')) throw invalid(`${record.path} lies outside the units the backup declares`);
    // Nothing is written through a link the backup holds, and no path comes twice.
    const seen = written.get(area) ?? written.set(area, { paths: new Set(), links: [] }).get(area);
    if (seen.paths.has(record.path) || seen.links.some(link => record.path.startsWith(`${link}/`))) throw invalid(`${record.path} comes twice, or lies under a link`);
    seen.paths.add(record.path);
    if (record.t === 'link') seen.links.push(record.path);
    if (record.t === 'dir' || record.t === 'link') {
      if (record.t === 'link' && typeof record.target !== 'string') throw invalid(`link ${record.path} has no target`);
      await visit({ ...record, unit: unit.path });
      return;
    }
    if (record.t !== 'file' || !Number.isSafeInteger(record.size) || record.size < 0 || typeof record.sha256 !== 'string' || !Number.isSafeInteger(record.chunks) || record.chunks < 1) throw invalid(`line ${lineNumber} is not a backup entry`);
    files++;
    bytes += record.size;
    const sink = await visit({ ...record, unit: unit.path });
    const hash = createHash('sha256');
    const state = {
      entry: record, hash, size: 0, left: record.chunks, write: sink?.write, abort: sink?.abort,
      async close() {
        await sink?.close?.();
        if (state.size !== record.size || hash.digest('hex') !== record.sha256) throw invalid(`${record.path} does not match its checksum`);
      },
    };
    pending = state;
  }

  let buffered = '';
  const decoder = new StringDecoder('utf8');
  let refused;
  try {
    await pipeline(createReadStream(file), createGunzip(), async function (source) {
      for await (const chunk of source) {
        buffered += decoder.write(chunk);
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const text = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (text) await take(text).catch(error => { refused ??= error; throw error; });
        }
      }
    });
  } catch (error) {
    await pending?.abort?.();
    // Some Node versions report the stream's own close in place of what the check threw.
    if (refused) throw refused;
    if (error instanceof AlpError) throw error;
    throw invalid(`it cannot be read (${error?.code ?? error?.message ?? error})`, { cause: error });
  }
  buffered += decoder.end();
  if (pending) await pending.abort?.();
  if (buffered) throw invalid('its last line is cut short');
  if (!header) throw invalid('it is empty');
  if (pending) throw invalid(`${pending.entry.path} is cut short`);
  if (!end) throw invalid('it has no end: the file was cut short');
  if (end.files !== files || end.bytes !== bytes || end.sha256 !== digest.digest('hex')) throw invalid('its end does not match its content');
  return { header, files, bytes };
}

/**
 * Checks a backup end to end without writing anything; says what it holds.
 * @param {string} file
 */
export async function verifyBackup(file) {
  let sessions = 0;
  let tasks = 0;
  const { header, files, bytes } = await readBackup(file, {
    visit(entry) {
      if (entry.t !== 'file') return;
      if (entry.area === 'home' && /^state\/sessions\/[^/]+\.json$/.test(entry.path)) sessions++;
      if (entry.area !== 'home' && /^\.alp\/tasks\/[^/]+\.json$/.test(entry.path)) tasks++;
    },
  });
  return {
    file, kind: header.kind, by: header.by, createdAt: header.createdAt, home: header.home, stateSchema: header.stateSchema,
    units: header.units.filter(unit => unit.kind !== 'absent').map(unit => unit.path),
    projects: header.projects.map(project => project.root),
    sessions, tasks, files, bytes, external: header.external?.length ?? 0,
  };
}

/** Moves the data of an unfinished restore back, or finishes one past its commit. */
async function settleJournal(journal, { releaseLocks = false } = {}) {
  if (journal.phase === 'committed') {
    for (const unit of journal.units) await rm(unit.aside, { recursive: true, force: true });
  } else {
    for (const unit of [...journal.units].reverse()) {
      if (await exists(unit.aside)) {
        await rm(unit.target, { recursive: true, force: true });
        await moveFile(unit.aside, unit.target);
      } else if (!unit.existed && unit.staged && !await exists(unit.staged)) {
        // Nothing stood there before; what stands there now came from the backup.
        await rm(unit.target, { recursive: true, force: true });
      }
    }
    if (journal.marker) await rm(journal.marker, { force: true });
  }
  for (const directory of journal.staging) await rm(directory, { recursive: true, force: true });
  // A project's .alp the restore created for its staging goes again when nothing else went in.
  for (const directory of journal.created ?? []) await rmdir(directory).catch(() => {});
  // Task locks the restore held: its process is gone, and the caller holds alpd's lock, so no other restore runs.
  if (releaseLocks) for (const lock of journal.locks ?? []) await rmdir(lock).catch(() => {});
}

/**
 * Settles a restore that stopped part way: rolled back before its commit, finished after it.
 * alpd and every restore call this first, so no one works on half-restored data.
 * @param {string} home
 * @returns {Promise<{ outcome: 'rolled back' | 'completed', file?: string, safety?: string } | undefined>}
 */
export async function recoverInterruptedRestore(home) {
  let journal;
  try { journal = JSON.parse(await readFile(journalFile(home), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new AlpError('RESTORE_JOURNAL_UNREADABLE', `${journalFile(home)} records an interrupted restore but cannot be read; see docs/alp/data-recovery.md before starting ALP`, { cause: error });
  }
  // A journal another ALP wrote in a form this one does not know is left for that ALP.
  if (journal?.version !== undefined && journal.version !== 1) throw new AlpError('RESTORE_JOURNAL_UNREADABLE', `${journalFile(home)} records a restore by another ALP version (journal ${journal.version}); finish it with that version`);
  if (!Array.isArray(journal?.units) || !Array.isArray(journal.staging)) throw new AlpError('RESTORE_JOURNAL_UNREADABLE', `${journalFile(home)} records an interrupted restore but does not say what moved; see docs/alp/data-recovery.md before starting ALP`);
  await settleJournal(journal, { releaseLocks: true });
  await rm(journalFile(home), { force: true });
  return { outcome: journal.phase === 'committed' ? 'completed' : 'rolled back', file: journal.file, safety: journal.safety };
}

/**
 * Holds the task locks of `roots` (those with tasks) while `work` runs. A writer takes a lock
 * older than ten seconds for a stale one, so a held lock is touched every two seconds.
 */
async function holdTaskLocks(roots, work) {
  const held = [];
  const touch = setInterval(() => { const now = new Date(); for (const lock of held) void utimes(lock, now, now).catch(() => {}); }, 2000);
  touch.unref?.();
  const take = async ([first, ...rest]) => {
    if (first === undefined) return work();
    if (!await exists(path.join(first, '.alp', 'tasks'))) return take(rest);
    return withTaskLock(first, () => { held.push(path.join(first, '.alp', 'tasks', '.lock')); return take(rest); });
  };
  try { return await take(roots); }
  finally { clearInterval(touch); }
}

/**
 * Restores a backup over `home` and, with `projects`, over the projects it holds whose
 * roots exist. The current data is checked first: a home in a state schema newer than
 * this ALP knows is refused unless `replaceNewer` says to replace it (it is saved first).
 * The caller keeps alpd away (it holds alpd's lock). `clearLive: false` keeps live work
 * and an unfinished migration's journal (a migration's rollback); `beforeSwap(index, total)` is a test hook, called before each swap and, with `index === total`, before the commit.
 * @param {{ home: string, file: string, projects?: boolean, safety?: boolean, clearLive?: boolean, replaceNewer?: boolean, by?: string, beforeSwap?: (index: number, total: number) => Promise<void> | void }} options
 */
export async function restoreBackup({ home, file, projects = true, safety = true, clearLive = true, replaceNewer = false, by = 'alp', beforeSwap }) {
  const interrupted = await recoverInterruptedRestore(home);
  // An older ALP never writes over state a newer one made unless told to; an unreadable marker is what a restore repairs.
  try { assertStateSupported(await readStateSchema(home), home); }
  catch (error) {
    if (error?.code !== 'STATE_SCHEMA_UNREADABLE' && !(error?.code === 'STATE_SCHEMA_TOO_NEW' && replaceNewer)) throw error;
  }

  const id = randomBytes(6).toString('hex');
  const staging = new Map(); // area → staging root
  const skipped = [];
  let header;
  const warnings = [];
  const areaBase = area => area === 'home' ? home : header.projects[Number(area.slice(8))].root;
  const directories = [];
  // The journal exists from the first staged file on, so a crash at any point leaves nothing behind.
  const journal = { version: 1, id, file: path.resolve(file), by, startedAt: new Date().toISOString(), phase: 'staging', units: [], staging: [], created: [], locks: [] };
  const record = () => writeAtomic(journalFile(home), JSON.stringify(journal) + '\n');
  const abandon = async () => { await settleJournal(journal); await rm(journalFile(home), { force: true }); };
  try {
    await readBackup(file, {
      async onHeader(found) {
        header = found;
        staging.set('home', path.join(home, `.restore-${id}`));
        for (const [index, project] of header.projects.entries()) {
          if (!projects) continue;
          if (!await stat(project.root).then(info => info.isDirectory(), () => false)) { skipped.push({ root: project.root, reason: 'the directory does not exist' }); continue; }
          if (!await exists(path.join(project.root, '.alp'))) journal.created.push(path.join(project.root, '.alp'));
          staging.set(`project:${index}`, path.join(project.root, '.alp', `.restore-${id}`));
        }
        journal.staging = [...staging.values()];
        await record();
      },
      async visit(entry) {
        const root = staging.get(entry.area);
        if (!root) return undefined; // a skipped project: checked, not written
        const target = path.join(root, ...entry.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        if (entry.t === 'dir') { await mkdir(target, { recursive: true, mode: 0o700 }); directories.push([target, entry.mode]); return undefined; }
        if (entry.t === 'link') { await symlink(entry.target, target); return undefined; }
        const handle = await open(target, 'wx', 0o600);
        return {
          write: chunk => handle.write(chunk).then(() => {}),
          close: async () => { await handle.close(); await chmod(target, entry.mode & 0o777 || 0o600).catch(() => {}); },
          abort: () => handle.close().catch(() => {}),
        };
      },
    });
    // Directory modes last, deepest first, once nothing more is written into them.
    for (const [directory, mode] of directories.reverse()) if (Number.isSafeInteger(mode)) await chmod(directory, mode & 0o777 | 0o700).catch(() => {});
  } catch (error) {
    await abandon();
    throw error;
  }

  // What the restored files say beyond their checksums: reported, not refused.
  for (const [area, root] of staging) {
    const base = area === 'home' ? 'state/sessions' : '.alp/tasks';
    for (const name of await readdir(path.join(root, ...base.split('/'))).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try { JSON.parse(await readFile(path.join(root, ...base.split('/'), name), 'utf8')); }
      catch { warnings.push(`${area === 'home' ? '' : `${areaBase(area)}/`}${base}/${name} is not readable JSON; ALP skips it as before`); }
    }
  }

  const plan = [];
  for (const [area, root] of staging) {
    const base = areaBase(area);
    const units = area === 'home' ? header.units : header.projects[Number(area.slice(8))].units;
    const known = area === 'home' ? HOME_UNITS : PROJECT_UNITS;
    for (const unit of units) {
      if (!known.includes(unit.path)) { warnings.push(`${unit.path} is not a unit this ALP restores; left as it is`); continue; }
      const target = path.join(base, ...unit.path.split('/'));
      const staged = unit.kind === 'absent' ? undefined : path.join(root, ...unit.path.split('/'));
      if (staged && !await exists(staged)) {
        // A unit the backup declares present must have arrived in full.
        await abandon();
        throw invalid(`${unit.path} is declared but missing from the backup`);
      }
      plan.push({ area, unit: unit.path, target, staged, aside: `${target}.pre-restore-${id}`, existed: await exists(target) });
    }
    if (area === 'home' && clearLive && units.some(unit => unit.path === 'state/sessions')) {
      for (const unit of CLEARED_UNITS) {
        const target = path.join(base, ...unit.split('/'));
        plan.push({ area, unit, target, staged: undefined, aside: `${target}.pre-restore-${id}`, existed: await exists(target) });
      }
    }
  }

  const roots = [...staging.keys()].filter(area => area !== 'home').map(areaBase);
  let safetyFile;
  if (safety) {
    try {
      safetyFile = await automaticBackup(home, 'pre-restore', { units: header.units.map(unit => unit.path).filter(unit => HOME_UNITS.includes(unit)), projects: roots, by });
    } catch (error) {
      await abandon();
      throw new AlpError('RESTORE_SAFETY_BACKUP_FAILED', `could not save the current data before restoring (${error?.message ?? error}); nothing was changed`, { cause: error });
    }
  }

  const locked = new Set();
  for (const root of roots) if (await exists(path.join(root, '.alp', 'tasks'))) locked.add(root);
  const marking = clearLive && plan.some(entry => entry.area === 'home' && entry.unit === 'state/sessions');
  Object.assign(journal, { safety: safetyFile, phase: 'swapping', units: plan, locks: [...locked].map(root => path.join(root, '.alp', 'tasks', '.lock')), ...(marking ? { marker: path.join(home, RESTORED) } : {}) });
  await record();
  let failure;
  try {
    await holdTaskLocks(roots, async () => {
      try {
        for (const [index, entry] of plan.entries()) {
          await beforeSwap?.(index, plan.length);
          if (entry.existed) await moveFile(entry.target, entry.aside);
          if (entry.staged) {
            await mkdir(path.dirname(entry.target), { recursive: true, mode: 0o700 });
            // Restored tasks stay locked until the task lock is let go, so no writer sees them half moved.
            if (entry.unit === '.alp/tasks' && locked.has(areaBase(entry.area))) await mkdir(path.join(entry.staged, '.lock')).catch(() => {});
            await moveFile(entry.staged, entry.target);
          }
        }
        // A restored state does not start working by itself: alpd reopens nothing until asked (ALPD §68).
        if (marking) {
          await mkdir(path.join(home, 'state'), { recursive: true, mode: 0o700 });
          await writeAtomic(path.join(home, RESTORED), JSON.stringify({ at: new Date().toISOString(), from: path.resolve(file), by }) + '\n');
        }
        await beforeSwap?.(plan.length, plan.length);
        journal.phase = 'committed';
        await record();
      } catch (error) {
        // Rolled back while the task locks are still held, so no writer saves into data about to go.
        try { await abandon(); }
        catch (rollback) {
          failure = new AlpError('RESTORE_ROLLBACK_FAILED', `restore failed (${error?.message ?? error}) and moving the data back failed (${rollback?.message ?? rollback}); ${journalFile(home)} records what is where, and the next alp restore or alpd start tries again`, { cause: error });
          return;
        }
        failure = new AlpError('RESTORE_FAILED', `restore failed and was rolled back; the data is as it was: ${error?.message ?? error}`, { cause: error });
      }
    });
  } catch (error) {
    // The task locks could not be taken: nothing was moved yet.
    if (journal.phase !== 'committed' && !failure) {
      await abandon();
      throw new AlpError('RESTORE_FAILED', `restore failed and was rolled back; the data is as it was: ${error?.message ?? error}`, { cause: error });
    }
  }
  if (failure) throw failure;
  await settleJournal(journal);
  await rm(journalFile(home), { force: true });
  return {
    file: path.resolve(file), safety: safetyFile, stateSchema: header.stateSchema, interrupted,
    units: plan.map(entry => ({ area: entry.area === 'home' ? 'home' : areaBase(entry.area), unit: entry.unit, present: !!entry.staged })),
    projects: roots, skipped, warnings,
  };
}

/** What a restore left for alpd's next start: open nothing by itself. Read at start, cleared once alpd is ready. */
export async function readRestoredMarker(home) {
  const text = await readFile(path.join(home, RESTORED), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return { at: undefined }; }
}

export async function clearRestoredMarker(home) {
  await rm(path.join(home, RESTORED), { force: true });
}
