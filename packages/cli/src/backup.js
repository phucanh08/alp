import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BACKUP_EXTENSION, backupsDir, createBackup, knownProjects, restoreBackup, verifyBackup } from '@anhlp/alp-core/backup';
import { acquireDaemonLock, alpHome, assertPrivateDirectory, daemonPaths, lockAlive, readLock, releaseDaemonLock, PROTOCOL_VERSION } from '@anhlp/alp-client/index';
import { daemonHeld, holdDaemon, releaseHold } from '@anhlp/alp-client/supervise';
import { start, stop } from './daemon.js';
import { UsageError } from './usage.js';

/* global __ALP_VERSION__ */
const VERSION = typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : 'dev';
const BY = `alp ${VERSION}`;

const size = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Runs `work` with alpd away (ALPD §68): its lock is taken for the maintenance, so no alpd
 * starts on data being read or replaced, and Paseo is held from starting one meanwhile. A
 * running alpd is stopped only with --stop, and started again after; what it was working on
 * is continued then, as after any stop (ALPD §31).
 */
async function withMaintenance(kind, { stopFirst }, work) {
  const home = alpHome();
  await assertPrivateDirectory(home, { create: true });
  const current = await readLock(home);
  const running = lockAlive(current);
  if (running && current.maintenance) throw new Error(`alp ${current.maintenance} already runs (pid ${current.pid})`);
  if (running && !stopFirst) throw new Error(`alpd is running (pid ${current.pid}); stop it first with alp daemon stop, or pass --stop: ALP then stops alpd for the ${kind} and starts it again after`);
  const wasHeld = await daemonHeld(home);
  await holdDaemon(home, `alp ${kind}`);
  let restart = false;
  try {
    if (running) restart = await stop();
    await acquireDaemonLock(home, { version: VERSION, protocolVersion: PROTOCOL_VERSION, socket: daemonPaths(home).socket, maintenance: kind });
    try { return await work(home); }
    finally { await releaseDaemonLock(home); }
  } finally {
    if (!wasHeld) await releaseHold(home);
    if (restart) {
      await start().then(() => console.log('alpd started again'), error => console.error(`alp: alpd did not start again (${error.message}); run alp daemon start`));
    }
  }
}

async function isProject(directory) {
  return access(path.join(directory, '.alp')).then(() => true, () => false);
}

/** alp backup [create] | verify <file> | list */
export async function backupCommand(args) {
  const [first, ...rest] = args;
  if (first === 'verify') return verifyCommand(rest);
  if (first === 'list') return listCommand(rest);
  const { values, positionals } = parseArgs({ args: first === 'create' ? rest : args, allowPositionals: true, options: {
    output: { type: 'string', short: 'o' }, project: { type: 'string', multiple: true }, 'no-projects': { type: 'boolean' }, stop: { type: 'boolean' }, json: { type: 'boolean' },
  } });
  if (positionals.length) throw new UsageError();
  const out = path.resolve(values.output ?? path.join(backupsDir(alpHome()), `backup-${stamp()}${BACKUP_EXTENSION}`));
  if (await stat(out).then(() => true, () => false)) throw new Error(`${out} exists; choose another file with -o`);
  const summary = await withMaintenance('backup', { stopFirst: values.stop }, async home => {
    let projects = [];
    if (!values['no-projects']) {
      // The projects the sessions worked in, those named, and this directory when it is one.
      const named = (values.project ?? []).map(directory => path.resolve(directory));
      for (const directory of named) if (!await isProject(directory)) throw new Error(`${directory} is not an ALP project (no .alp directory)`);
      const here = await isProject(process.cwd()) ? [path.resolve(process.cwd())] : [];
      projects = [...new Set([...await knownProjects(home), ...named, ...here])].sort();
    }
    return createBackup({ home, out, projects, by: BY });
  });
  if (values.json) { console.log(JSON.stringify(summary)); return; }
  console.log(`backup written to ${out} (${size((await stat(out)).size)})`);
  console.log(`  ${summary.sessions} session record${summary.sessions === 1 ? '' : 's'}, state schema ${summary.stateSchema ?? 'unknown'}; ${summary.tasks} task${summary.tasks === 1 ? '' : 's'} in ${summary.projects.length} project${summary.projects.length === 1 ? '' : 's'}${summary.projects.length ? `: ${summary.projects.join(', ')}` : ''}`);
  console.log('  it holds your settings and library too, and may hold credentials from them: keep it private. Codex and Claude keep their own threads; see docs/alp/data-recovery.md');
}

async function verifyCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const contents = await verifyBackup(path.resolve(positionals[0]));
  if (values.json) { console.log(JSON.stringify(contents)); return; }
  console.log(`${contents.file}: complete and intact`);
  console.log(`  made ${contents.createdAt}${contents.by ? ` by ${contents.by}` : ''} (${contents.kind}) from ${contents.home}; state schema ${contents.stateSchema ?? 'unknown'}`);
  console.log(`  ${contents.sessions} session records, ${contents.tasks} tasks, ${contents.files} files, ${size(contents.bytes)}`);
  if (contents.projects.length) console.log(`  projects: ${contents.projects.join(', ')}`);
}

async function listCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const directory = backupsDir(alpHome());
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith(BACKUP_EXTENSION)).sort();
  const files = await Promise.all(names.map(async name => { const info = await stat(path.join(directory, name)); return { file: path.join(directory, name), bytes: info.size, at: info.mtime.toISOString() }; }));
  if (values.json) { console.log(JSON.stringify(files)); return; }
  if (!files.length) { console.log(`no backups in ${directory}`); return; }
  for (const file of files) console.log(`${file.at}  ${size(file.bytes).padStart(9)}  ${file.file}`);
}

/** alp restore <file> [--home-only] [--stop] [--dry-run] [--replace-newer] [--json] */
export async function restoreCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'home-only': { type: 'boolean' }, stop: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'replace-newer': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  if (positionals.length !== 1) throw new UsageError();
  const file = path.resolve(positionals[0]);
  if (values['dry-run']) {
    const contents = await verifyBackup(file);
    const missing = [];
    for (const root of contents.projects) if (!await stat(root).then(info => info.isDirectory(), () => false)) missing.push(root);
    if (values.json) { console.log(JSON.stringify({ ...contents, missing })); return; }
    console.log(`${file} is intact; a restore would replace, in ${alpHome()}: ${contents.units.join(', ') || 'nothing'}`);
    if (!values['home-only']) for (const root of contents.projects) console.log(`  and in ${root}: its ALP files and tasks${missing.includes(root) ? ' (skipped: the directory does not exist)' : ''}`);
    console.log('nothing was changed');
    return;
  }
  const result = await withMaintenance('restore', { stopFirst: values.stop }, home => restoreBackup({ home, file, projects: !values['home-only'], replaceNewer: values['replace-newer'], by: BY }));
  if (values.json) { console.log(JSON.stringify(result)); return; }
  if (result.interrupted) console.log(`an earlier restore was cut short and has been ${result.interrupted.outcome}`);
  console.log(`restored ${file}`);
  console.log(`  ${alpHome()}: ${result.units.filter(unit => unit.area === 'home' && unit.present).map(unit => unit.unit).join(', ') || 'nothing'}`);
  for (const root of result.projects) console.log(`  ${root}: ${result.units.filter(unit => unit.area === root && unit.present).map(unit => unit.unit).join(', ') || 'nothing'}`);
  for (const { root, reason } of result.skipped) console.log(`  skipped ${root}: ${reason}`);
  for (const warning of result.warnings) console.log(`  note: ${warning}`);
  if (result.stateSchema !== null && result.stateSchema !== undefined) console.log('  sessions that were working when the backup was made wait for you; alpd continues none by itself');
  if (result.safety) console.log(`the data it replaced is in ${result.safety}; alp restore ${result.safety} puts it back`);
}
