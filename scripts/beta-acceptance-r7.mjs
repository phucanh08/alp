#!/usr/bin/env node
// R7 of docs/alp/beta-scope.md §6.1/§6.3: real worktrees and alp_merge, from the source at the release
// SHA (not the tarballs), once per provider. Real model calls: live only, at the user's cost.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, Run, capture } from './beta-acceptance-lib.mjs';

const USAGE = `Usage: node scripts/beta-acceptance-r7.mjs --live --model codex:<model> [--model claude:<model>] [--sha <release SHA>] [--work DIR] [--runner NAME] [--evidence URL]

Runs test/e2e/worktree-e2e.mjs in this checkout once per --model (ALP_TEST_MODEL), after
npm ci && npm run build at the release SHA. Real model calls; there is no --fake for R7.
--sha checks that HEAD is the release SHA; without it HEAD is recorded as is.
--evidence names where the row's evidence lives (e.g. the CI run); default the results file.
Exit 3: the row is not complete yet (e.g. one provider only); R7 needs both, on macOS and Linux.`;

let values;
try { ({ values } = parseArgs({ args: process.argv.slice(2), options: { live: { type: 'boolean' }, model: { type: 'string', multiple: true }, sha: { type: 'string' }, work: { type: 'string' }, runner: { type: 'string' }, evidence: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })); }
catch (error) { console.error(`${error.message}\n\n${USAGE}`); process.exit(2); }
if (values.help) { console.log(USAGE); process.exit(0); }
const models = values.model ?? [];
if (!values.live || !models.length || models.some(model => !/^(codex|claude):\S+$/.test(model))) { console.error(USAGE); process.exit(2); }
if (!['darwin', 'linux'].includes(process.platform)) { console.error('R7 runs on macOS and Linux (beta-scope §6.1).'); process.exit(2); }

const head = capture('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).trim();
const dirty = capture('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT }).trim();
const work = path.resolve(values.work ?? path.join(os.tmpdir(), 'alp-beta'));
const run = new Run({ work, name: `r7-${process.platform}-${new Date().toISOString().replace(/[:.]/g, '-')}`, row: 'R7', mode: 'live', runner: values.runner, evidence: values.evidence });
run.sha = head;

await run.step('R7-source', 'checkout at the release SHA, built', async () => {
  const problems = [];
  if (values.sha && head !== values.sha) problems.push(`HEAD is ${head}, not the release SHA ${values.sha}`);
  if (dirty) problems.push('tracked files differ from HEAD; the run would not be of the release SHA');
  if (!existsSync(path.join(ROOT, 'dist', 'runtime', 'index.js'))) problems.push('not built: run npm ci && npm run build');
  if (problems.length) throw new Error(problems.join('; '));
  run.record('R7-source', values.sha ? 'pass' : 'check', `HEAD ${head}${values.sha ? ' is the release SHA' : ' — compare it with RELEASE_SHA yourself'}; clean; built`);
});

for (const model of models) {
  await run.step(`R7-${model.split(':')[0]}`, `worktree-e2e with ${model}`, async () => {
    const result = run.exec(`R7-${model.split(':')[0]}`, process.execPath, ['test/e2e/worktree-e2e.mjs'], { cwd: ROOT, env: { ...process.env, ALP_TEST_MODEL: model } });
    if (result.status !== 0) throw new Error(`exit ${result.status ?? result.error?.message}: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    run.record(`R7-${model.split(':')[0]}`, 'pass', `worktree-e2e exited 0 with ${model}`, { model });
  });
}
if (models.length < 2) run.record('R7-providers', 'pending', 'R7 needs both Codex and Claude on each OS; run again with the other --model');
process.exit(run.summary());
