import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { alpHome } from './library.js';
import { AlpError } from './errors.js';

/**
 * A record of the human gates ALP opened and the clears ALP itself made, kept in
 * $ALP_HOME, outside the project. The task files in .alp/tasks are plain files an
 * agent can edit; when one shows a ledgered human gate cleared or gone without a
 * clear here, loadTasks reopens it and marks it `tampered`.
 *
 * This detects an edit of the task file only. It is not a security boundary: an
 * agent running as the same OS user can edit this file too (t-ca1f residual risk).
 * Human gates from before the ledger enter it the next time ALP writes their task.
 */

const key = (taskId, gate) => `${taskId}/${gate.id}@${gate.at}`;

/** One project's ledger, by its real path: /tmp and /private/tmp are the same project. */
function realRoot(projectRoot) {
  try { return realpathSync.native(path.resolve(projectRoot)); } catch { return path.resolve(projectRoot); }
}

function ledgerFile(projectRoot) {
  const hash = createHash('sha256').update(realRoot(projectRoot)).digest('hex').slice(0, 24);
  return path.join(alpHome(), 'gates', `${hash}.json`);
}

/**
 * The project's ledger. A missing one is empty. On read (`strict` false) an unreadable or corrupt
 * one detects nothing and never blocks the task graph; a writer (`strict`) refuses it instead,
 * so it never overwrites entries it could not read.
 */
export async function readLedger(projectRoot, { strict = false } = {}) {
  let data;
  try {
    data = JSON.parse(await readFile(ledgerFile(projectRoot), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { gates: {} };
    if (strict) throw new AlpError('GATE_LEDGER_UNREADABLE', `The gate ledger ${ledgerFile(projectRoot)} is unreadable (${error.message}); fix or remove it`);
    return { gates: {} };
  }
  if (data && typeof data === 'object' && data.gates && typeof data.gates === 'object') return data;
  if (strict) throw new AlpError('GATE_LEDGER_UNREADABLE', `The gate ledger ${ledgerFile(projectRoot)} is not a ledger; fix or remove it`);
  return { gates: {} };
}

async function writeLedger(projectRoot, ledger) {
  const file = ledgerFile(projectRoot);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

/** Records the open human gates of a task ALP just wrote (addGate, a formula's human step, a beads import) that it does not hold yet. */
export async function ledgerAdopt(projectRoot, task) {
  const open = (task.gates ?? []).filter(gate => gate.kind === 'human' && !gate.resolved && typeof gate.at === 'string' && /^g\d+$/.test(gate.id));
  if (!open.length) return;
  const ledger = await readLedger(projectRoot, { strict: true });
  const missing = open.filter(gate => !ledger.gates[key(task.id, gate)]);
  if (!missing.length) return;
  ledger.project = realRoot(projectRoot);
  for (const gate of missing) ledger.gates[key(task.id, gate)] = { opened: gate.at };
  await writeLedger(projectRoot, ledger);
}

/**
 * Records that ALP cleared or removed a human gate. Written under the task lock once every check
 * passed and before the task file: should the file write fail, the gate stays open in the file.
 */
export async function ledgerResolve(projectRoot, taskId, gate, { by, channel, removed = false }) {
  const ledger = await readLedger(projectRoot, { strict: true });
  const entry = ledger.gates[key(taskId, gate)];
  if (!entry) return;
  entry.resolved = { at: new Date().toISOString(), by, ...(channel ? { channel } : {}), ...(removed ? { removed: true } : {}) };
  await writeLedger(projectRoot, ledger);
}

/**
 * Reopens, in the loaded tasks, every ledgered human gate the files show cleared or
 * removed without a clear in the ledger, marking it `tampered`.
 */
export function applyLedger(tasks, ledger) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const [name, entry] of Object.entries(ledger.gates ?? {})) {
    if (!entry || entry.resolved) continue;
    const match = /^(.+)\/(g\d+)@(.+)$/.exec(name);
    if (!match) continue;
    const [, taskId, gateId, at] = match;
    const task = byId.get(taskId);
    if (!task) continue;
    task.gates = Array.isArray(task.gates) ? task.gates : [];
    const gate = task.gates.find(item => item.id === gateId);
    if (gate && gate.at === at && gate.kind === 'human' && !gate.resolved) continue;
    if (gate) {
      const { resolved, ...open } = gate;
      task.gates = task.gates.map(item => item === gate ? { ...open, kind: 'human', at, ...(open.note ? {} : { note: 'restored: this human gate was changed outside ALP' }), tampered: { at: resolved?.at ?? null, by: resolved?.by ?? null } } : item);
    } else {
      task.gates = [...task.gates, { id: gateId, kind: 'human', note: 'restored: this human gate was removed outside ALP', at, tampered: { removed: true } }];
    }
    // A step closed by the forged approval opens again.
    if (task.step?.human && task.status === 'closed') { task.status = 'open'; task.closed = null; }
  }
  return tasks;
}

/**
 * Drops the entries that no longer guard anything (t-f438): every cleared one (applyLedger skips
 * them), and the open ones of a closed task whose file still shows that gate open and untampered.
 * When every task file read (`complete`), also those of tasks that are gone: applyLedger cannot
 * restore a gate without its task. Called from compaction, under the task lock. Returns how many.
 */
export async function ledgerPrune(projectRoot, tasks, { complete = false } = {}) {
  const ledger = await readLedger(projectRoot, { strict: true });
  const byId = new Map(tasks.map(task => [task.id, task]));
  let dropped = 0;
  for (const [name, entry] of Object.entries(ledger.gates)) {
    const match = /^(.+)\/(g\d+)@(.+)$/.exec(name);
    const task = match ? byId.get(match[1]) : undefined;
    const gate = task?.gates?.find(item => item.id === match[2]);
    const settled = !entry || entry.resolved
      || (task ? task.status === 'closed' && gate?.kind === 'human' && gate.at === match[3] && !gate.resolved && !gate.tampered : complete && !!match);
    if (!settled) continue;
    delete ledger.gates[name];
    dropped += 1;
  }
  if (dropped) await writeLedger(projectRoot, ledger);
  return dropped;
}
