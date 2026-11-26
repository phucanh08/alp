import { parseArgs } from 'node:util';
import { describeVerification, runVerify, verifyConfig } from '@anhlp/alp-core/verify';
import { probeAntigravity } from '@anhlp/alp-client/antigravity-probe';
import { getTask, recordVerification } from '@anhlp/alp-core/tasks';
import { taskProject } from '../_shared/project.ts';
import { UsageError } from '../_shared/usage.ts';

/** alp verify: run the project's verify commands here, in the project root. */

export async function verify(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, task: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals[0] === 'antigravity') {
    const result = await probeAntigravity({}, { cwd: process.cwd() });
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`Antigravity ${result.version || 'installed'}: ok (${result.models.length} models)`);
    return;
  }
  if (positionals.length) throw new UsageError();
  const root = await taskProject(values.project);
  const config = await verifyConfig(root);
  if (!config) throw new Error(`${root} has no verify commands; add "verify": { "test": "npm test" } to .alp/settings.json`);
  if (values.task) await getTask(root, values.task);
  const verification = await runVerify(root, config);
  if (values.task) await recordVerification(root, values.task, { ...verification, where: 'checkout' }, 'user');
  if (values.json) console.log(JSON.stringify(verification));
  else {
    for (const command of verification.commands) {
      console.log(`${command.exitCode === 0 ? '✓' : '✗'} ${command.step}: ${command.command}  (${(command.ms / 1000).toFixed(1)} s${command.timedOut ? ', timed out' : command.exitCode ? `, exit ${command.exitCode}` : ''})`);
      if (command.exitCode !== 0 && command.output) console.log(`  ${command.output.trimEnd().split('\n').slice(-30).join('\n  ')}`);
    }
    console.log(`${describeVerification(verification)}${values.task ? `; recorded on ${values.task}` : ''}`);
  }
  if (!verification.passed) process.exitCode = 1;
}
