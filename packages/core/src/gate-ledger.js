import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { alpHome } from './library.js';

/**
 * A record of the human gates ALP opened and the clears ALP itself made, kept in
 * $ALP_HOME, outside the project. The task files in .alp/tasks are plain files an
 * agent can edit; when one shows a ledgered human gate cleared or gone without a
 * clear here, loadTasks reopens it and marks it `tampered`.
 *
 * This detects an edit of the task file only. It is not a security boundary: an
 * agent running as the same OS user can edit this file too (t-ca1f residual risk).
 * Human gates from before the ledger are not in it and are taken as they are.
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

export async function readLedger(projectRoot) {
  try {
    const data = JSON.parse(await readFile(ledgerFile(projectRoot), 'utf8'));
    return data && typeof data.gates === 'object' && data.gates ? data : { gates: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { gates: {} };
    // An unreadable ledger detects nothing; it never blocks the task graph.
    return { gates: {} };
  }
}

async function writeLedger(projectRoot, ledger) {
  const file = ledgerFile(projectRoot);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

/** Records a human gate ALP opened. */
export async function ledgerOpen(projectRoot, taskId, gate) {
  const ledger = await readLedger(projectRoot);
  ledger.project = realRoot(projectRoot);
  ledger.gates[key(taskId, gate)] = { opened: gate.at };
  await writeLedger(projectRoot, ledger);
}

/** Records that ALP cleared or removed a human gate; written before the task file, so a failure leaves the gate open. */
export async function ledgerResolve(projectRoot, taskId, gate, { by, channel, removed = false }) {
  const ledger = await readLedger(projectRoot);
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
