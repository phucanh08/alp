import { parseArgs } from 'node:util';
import { ago, duration } from '@anhlp/alp-client/render';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';

/** One tree as text: sessions by depth, then questions, unmerged worktrees and leases. */

export function renderStatus(
  // any: session.status's tree as alpd sends it (sessions, assignments, questions, worktrees, leases, claims).
  status: any,
  // any: the root's row from session.list, or undefined; only its title is read.
  root: any,
  // any: the run log's strategy entries, as latestStrategies returns them.
  strategies: Map<string, any> = new Map(),
): string {
  const lines = [`${root?.title ? `"${root.title}"  ` : ''}${status.rootId}  ${status.sessions[0]?.projectRoot ?? ''}`];
  const depth = new Map<string, number>();
  // any: the assignment rows of session.status.
  const assignments = new Map<string, any>(status.assignments.map((assignment: any) => [assignment.id, assignment]));
  for (const session of status.sessions) {
    depth.set(session.id, session.parentId ? (depth.get(session.parentId) ?? 0) + 1 : 0);
    const assignment = assignments.get(session.id);
    const where = assignment?.worktree ? `  worktree ${assignment.worktree.branch}` : '';
    const mail = session.unreadMail ? `  ✉${session.unreadMail}` : '';
    const strategy = strategies.get(session.id) ?? (!session.parentId || session.agent === 'lead' ? { strategy: 'smart' } : undefined);
    const chosen = strategy ? `  strategy ${strategy.strategy}${strategy.reason ? `: ${strategy.reason.split('\n')[0].slice(0, 80)}` : ''}` : '';
    lines.push(`${'  '.repeat(depth.get(session.id)! + 1)}${session.agent.padEnd(9)} ${session.state.padEnd(14)} idle ${duration(session.idleMs).padEnd(7)} ${session.runtime}:${session.model}  ${session.mode}${where}${mail}${chosen}`);
  }
  for (const question of status.questions) lines.push(`  ? ${question.id} ${question.agent} asks (${ago(question.askedAt)}): ${question.body.split('\n')[0]}`);
  for (const worktree of status.worktrees) lines.push(`  ⎇ unmerged ${worktree.branch} from ${worktree.agent}: ${worktree.files.length} files${worktree.stat ? ` (${worktree.stat.trim()})` : ''}`);
  for (const lease of status.leases) lines.push(`  ⚿ ${lease.agent} holds the write lease on ${lease.checkout}`);
  for (const claim of status.claims ?? []) lines.push(`  ⚑ ${claim.agent} claims ${claim.paths.join(', ')}${claim.task ? ` for ${claim.task}` : ''}: ${claim.body.split('\n')[0].slice(0, 100)}`);
  return lines.join('\n');
}

/** The latest alp_strategy entry of each session in a run log (t-003a); a session without one works with smart. */
// any: run-log entries as alpd reads them from JSONL; only event and sessionId are checked.
export function latestStrategies(entries: any[]): Map<string, any> {
  // any: each session's latest strategy entry as written to the run log.
  const latest = new Map<string, any>();
  for (const entry of entries) if (entry?.event === 'strategy' && typeof entry.sessionId === 'string') latest.set(entry.sessionId, entry);
  return latest;
}

/** How long alp top reuses a tree's strategies before it reads the run log again. */
export const STRATEGY_REFRESH_MS = 5000;

/** A live dashboard of every tree, or of one, refreshed every second. */

export async function top(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { once: { type: 'boolean' } } });
  if (positionals.length > 1) throw new UsageError();
  const client = await running();
  // Strategies live only in the run log, which alpd reads whole: read it at most every STRATEGY_REFRESH_MS per tree.
  const strategies = new Map<string, { at: number; latest: Map<string, any> }>(); // any: see latestStrategies
  const strategiesOf = async (rootId: string) => {
    const cached = strategies.get(rootId);
    if (cached && Date.now() - cached.at < STRATEGY_REFRESH_MS) return cached.latest;
    const { entries } = await client.request('session.log', { sessionId: rootId }).catch(() => ({ entries: cached ? undefined : [] }));
    // entries is undefined only when a cached value exists.
    const latest = entries ? latestStrategies(entries) : cached!.latest;
    strategies.set(rootId, { at: Date.now(), latest });
    return latest;
  };
  const frame = async () => {
    const { sessions } = await client.request('session.list', { rootsOnly: true });
    // any: session.list rows as alpd sends them.
    const roots = positionals.length ? sessions.filter((session: any) => session.id === positionals[0]) : sessions;
    if (positionals.length && !roots.length) throw new Error(`Session ${positionals[0]} is not a live root`);
    const blocks: string[] = [];
    // Trees that ended leave the cache.
    // any: session.list rows (see above).
    for (const rootId of strategies.keys()) if (!roots.some((root: any) => root.id === rootId)) strategies.delete(rootId);
    for (const root of roots) {
      const { status } = await client.request('session.status', { sessionId: root.id }).catch(() => ({}));
      if (status) blocks.push(renderStatus(status, root, await strategiesOf(root.id)));
    }
    return `alp top  ${new Date().toLocaleTimeString()}  ${roots.length} live ${roots.length === 1 ? 'tree' : 'trees'}\n\n${blocks.join('\n\n') || 'No live sessions'}`;
  };
  try {
    if (values.once || !process.stdout.isTTY) { console.log(await frame()); return; }
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    while (!stop) {
      const text = await frame();
      process.stdout.write(`\x1b[2J\x1b[H${text}\n\n(Ctrl-C to exit)\n`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    client.close();
  }
}
