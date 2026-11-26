import { parseArgs } from 'node:util';
import { diagnose, repair } from '@anhlp/alp-client/doctor';
import { alpHome } from '@anhlp/alp-client/index';
import { taskProject } from '../_shared/project.ts';
import { UsageError } from '../_shared/usage.ts';
import { DAEMON_ENTRY } from '../../paths.ts';

const DOCTOR_MARK = { ok: '✓', info: '·', warn: '!', fail: '✗' };

export async function doctor(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, fix: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const project = values.project ? await taskProject(values.project) : await taskProject(undefined).catch(() => undefined);
  // This file is never built, so the import fails and doctor gets sandbox undefined; the dead
  // import is tracked by task t-b156 and kept as it is here.
  // @ts-expect-error TS2307: the module does not exist (see above).
  const sandbox = await import('../../../dist/runtime/index.js').then(runtime => runtime.claudeSandboxAvailable(), () => undefined);
  const options = { home: alpHome(), project, sandbox, daemonEntry: DAEMON_ENTRY };
  let checks = await diagnose(options);
  const fixed = values.fix ? await repair(checks) : [];
  if (fixed.length) checks = await diagnose(options);
  if (values.json) {
    console.log(JSON.stringify({ project: project ?? null, checks: checks.map(({ fix, ...check }) => ({ ...check, ...(fix ? { fix: fix.describe } : {}) })), fixed }));
  } else {
    for (const { id, result } of fixed) console.log(`fixed ${id}: ${result}`);
    if (fixed.length) console.log('');
    for (const check of checks) {
      console.log(`${DOCTOR_MARK[check.status]} ${check.id.padEnd(13)} ${check.summary}`);
      for (const detail of check.details ?? []) console.log(`    ${detail}`);
      if (check.fix) console.log(`    --fix: ${check.fix.describe}`);
      if (check.hint) console.log(`    ${check.hint}`);
    }
    const failed = checks.filter(check => check.status === 'fail').length;
    const warned = checks.filter(check => check.status === 'warn').length;
    const fixable = checks.filter(check => check.fix).length;
    console.log(`\n${failed || warned ? `${failed} failed, ${warned} to look at` : 'All good'}${project ? '' : ' (no ALP project here; pass --project to check one)'}${fixable ? `; alp doctor --fix repairs ${fixable}` : ''}`);
  }
  if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
}
