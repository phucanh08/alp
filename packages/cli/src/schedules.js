import path from 'node:path';
import { parseArgs } from 'node:util';
import { running } from './daemon.js';
import { UsageError } from './usage.js';

/** One-shot continuations of an existing root session; timestamps need an explicit offset. */
export async function scheduleCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, session: { type: 'string' }, at: { type: 'string' },
    prompt: { type: 'string' }, status: { type: 'string' }, json: { type: 'boolean' },
  } });
  const [action, id, ...extra] = positionals;
  if (!['create', 'list', 'show', 'cancel'].includes(action) || extra.length) throw new UsageError();
  if ((action === 'show' || action === 'cancel') ? !id : !!id) throw new UsageError();
  if (action !== 'create' && (values.session || values.at || values.prompt)) throw new UsageError();
  if (action !== 'list' && values.status) throw new UsageError();
  if (action === 'create' && (!values.session || !values.prompt?.trim() ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(values.at ?? '') ||
      !Number.isFinite(Date.parse(values.at)))) throw new Error('create needs --session, --prompt and --at ISO timestamp with Z or a UTC offset (for example 2026-10-20T16:00:00+07:00)');
  const projectRoot = path.resolve(values.project ?? process.cwd());
  const params = action === 'create'
    ? { projectRoot, sessionId: values.session, dueAt: values.at, prompt: values.prompt }
    : { projectRoot, ...(id ? { id } : {}), ...(values.status ? { status: values.status } : {}) };
  const client = await running();
  try {
    const result = await client.request(`schedule.${action === 'show' ? 'get' : action}`, params);
    if (values.json) { console.log(JSON.stringify(result)); return; }
    const jobs = result.jobs ?? [result.job];
    if (!jobs.length) console.log('No scheduled continuations');
    for (const job of jobs) {
      console.log(`${job.id}  ${job.status}  ${job.dueAt}  session ${job.sessionId}`);
      console.log(`  ${job.prompt}`);
      if (job.attemptedAt) console.log(`  attempted ${job.attemptedAt}; attempts ${job.attempts}; late ${job.lateByMs ?? 0} ms`);
      for (const field of ['deliveredAt', 'failedAt', 'cancelledAt']) if (job[field]) console.log(`  ${field}: ${job[field]}`);
      if (job.lastError) console.log(`  ${job.lastError.code ?? 'error'}: ${job.lastError.message}`);
    }
  } finally { client.close(); }
}
