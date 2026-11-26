import { describeVerification } from '@anhlp/alp-core/verify';
import { ago } from '@anhlp/alp-client/render';
import { blockersOf, childrenOf, describeGate, gateOpen, gatesOf, summarize } from '@anhlp/alp-core/tasks';
import type { Task } from '@anhlp/alp-core/tasks';

export const STATUS_MARK = { open: '○', in_progress: '◐', review: '◑', closed: '●' };

export function taskRow(task: Task, tasks: Task[]): string {
  const row = summarize(task, tasks);
  const extra = [
    row.blockedBy ? `blocked by ${row.blockedBy.join(', ')}` : '',
    row.gates ? `waits on ${row.gates.join('; ')}` : '',
    row.assignee ? `@${row.assignee}` : '',
    row.labels ? row.labels.map(label => `#${label}`).join(' ') : '',
  ].filter(Boolean).join('  ');
  return `${STATUS_MARK[task.status]} ${task.id.padEnd(10)} P${task.priority} ${task.type.padEnd(7)} ${task.status.padEnd(11)} ${task.title}${extra ? `  ${extra}` : ''}`;
}

export function warnUnreadable(errors: Array<{ file: string; error: string }>) {
  for (const { file, error } of errors) console.error(`alp: skipped ${file}: ${error}`);
}

export function printTask(task: Task, tasks: Task[]) {
  console.log(`${STATUS_MARK[task.status]} ${task.id}  ${task.title}`);
  console.log(`  ${task.type}, P${task.priority}, ${task.status}${task.assignee ? ` with ${task.assignee.agent}` : ''}; created by ${task.createdBy} ${ago(task.createdAt)} ago, rev ${task.rev}`);
  if (task.description) console.log(`\n  ${task.description.replace(/\n/g, '\n  ')}\n`);
  const blockers = task.status === 'closed' ? [] : blockersOf(task, tasks);
  const relations = [
    task.parent && `parent ${task.parent}`,
    task.blockedBy.length && `after ${task.blockedBy.join(', ')}${blockers.length ? ` (open: ${blockers.join(', ')})` : ''}`,
    task.discoveredFrom && `found during ${task.discoveredFrom}`,
    task.related.length && `related ${task.related.join(', ')}`,
  ].filter(Boolean);
  if (relations.length) console.log(`  ${relations.join('; ')}`);
  for (const gate of task.gates) console.log(`  ${gateOpen(gate) ? '⏸' : '✓'} gate ${describeGate(gate)}${gate.resolved ? ` (cleared by ${gate.resolved.by}${gate.resolved.choice ? ` with "${gate.resolved.choice}"` : ''}${gate.resolved.channel ? ` in ${gate.resolved.channel}` : ''}${gate.resolved.note ? `: ${gate.resolved.note}` : ''})` : gate.rejected ? ` (rejected by ${gate.rejected.by}${gate.rejected.reason ? `: ${gate.rejected.reason}` : ''})` : ''}${gateOpen(gate) && gate.options ? ` options: ${gate.options.join(' | ')}` : ''}${gate.tampered ? ' ⚠ changed outside ALP (a task file edit cleared or removed it); reopened for you to decide' : ''}`);
  const inherited = gatesOf(task, tasks).filter(label => label.startsWith('t-'));
  if (task.status !== 'closed' && inherited.length) console.log(`  waits on its parent's gates: ${inherited.join('; ')}`);
  if (task.compacted) console.log(`  compacted ${task.compacted.at.slice(0, 10)} from ${task.compacted.chars} characters`);
  if (task.labels.length) console.log(`  labels: ${task.labels.join(', ')}`);
  if (task.paths.length) console.log(`  paths: ${task.paths.join(', ')}`);
  for (const child of childrenOf(task.id, tasks)) console.log(`  ${taskRow(child, tasks)}`);
  if (task.verified) console.log(`  ${task.verified.skipped ? '–' : task.verified.passed ? '✓' : '✗'} ${describeVerification(task.verified)}${task.verified.where ? ` in the ${task.verified.where}` : ''}, ${ago(task.verified.at)} ago`);
  if (task.closed) console.log(`  closed ${task.closed.reason} by ${task.closed.by}${task.closed.summary ? `: ${task.closed.summary}` : ''}${task.closed.unverified ? ` (unverified: ${task.closed.unverified})` : ''}`);
  for (const entry of task.log.slice(-10)) {
    const { at, by, event, ...detail } = entry;
    const text = Object.entries(detail).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(', ') : value}`).join('; ');
    console.log(`  ${at.slice(0, 16).replace('T', ' ')}  ${by} ${event}${text ? `: ${text}` : ''}`);
  }
}
