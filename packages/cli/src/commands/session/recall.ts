import { parseArgs } from 'node:util';
import { ago } from '@anhlp/alp-client/render';
import { isTaskId } from '@anhlp/alp-core/tasks';
import { taskProject } from '../_shared/project.ts';
import { UsageError } from '../_shared/usage.ts';
import { running } from '../daemon/index.ts';

/** alp recall: ask a finished assignment, or the last one on a task, what it did and why. */
export async function recall(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  const [target, ...words] = positionals;
  const question = words.join(' ').trim();
  if (!target || !question) throw new UsageError();
  const byTask = isTaskId(target);
  const client = await running();
  const answer = await client.request('assignment.recall', {
    ...(byTask ? { taskId: target, projectRoot: await taskProject(values.project) } : { assignmentId: target }),
    question,
  }).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(answer)); return; }
  console.log(`${answer.agent} (assignment ${answer.assignmentId}${answer.taskId ? `, task ${answer.taskId}` : ''}, finished ${ago(answer.finishedAt)} ago):`);
  console.log(answer.answer);
}
