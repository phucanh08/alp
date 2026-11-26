#!/usr/bin/env node
// Root test entry: `unit` (every packages/*/tests), `integration` (test/integration), `e2e`
// (test/e2e, live providers, opt-in) or `all`. Without an argument it runs the hermetic suites,
// unit and integration together in one `node --test` run, so no file executes twice.
import { spawnSync } from 'node:child_process';
import { ROOT, assertTypeStripping, buildAll, buildWorkspace, hermeticEnv, integrationTests, packageTests, packages, runNodeTests, webTests } from './test-lib.ts';

assertTypeStripping('scripts/test.ts');

const scope = process.argv[2] ?? 'hermetic';
const usage = 'Usage: test.ts [unit|integration|e2e|hermetic|all]';
if (!['unit', 'integration', 'e2e', 'hermetic', 'all'].includes(scope)) throw new Error(usage);

// Live e2e suites call real providers and, for some, a running Paseo host. The Paseo lanes drive only a
// scratch daemon the caller declares (ALP_TEST_ALP_HOME, ALP_TEST_PASEO_URL; test/e2e/scratch-daemon.ts)
// and refuse the user's own daemon (:6767) and ~/.alp. Each runs without the caller's ALP session.
const e2e = [
  ['test/e2e/workflow-e2e.ts', 'pho'], ['test/e2e/workflow-e2e.ts', 'cafe'],
  ['test/e2e/mailbox-e2e.ts', 'ask'], ['test/e2e/mailbox-e2e.ts', 'wake'], ['test/e2e/mailbox-e2e.ts', 'steer'],
  ['test/e2e/team-e2e.ts'], ['test/e2e/claude-e2e.ts'], ['test/e2e/claude-runtime-e2e.ts'],
  ['test/e2e/paseo-e2e.ts'], ['test/e2e/alpd-e2e.ts'], ['test/e2e/viewer-detach-e2e.ts'], ['test/e2e/persistence-e2e.ts'],
  ['test/e2e/import-e2e.ts'], ['test/e2e/worktree-e2e.ts'], ['test/e2e/human-e2e.ts', 'cli'], ['test/e2e/human-e2e.ts', 'paseo'], ['test/e2e/board-e2e.ts'],
];
const unit = () => [...packages.flatMap(name => packageTests(name)), ...webTests()];

let status = 0;
if (scope !== 'e2e') {
  buildAll();
  const files = scope === 'unit' ? unit() : scope === 'integration' ? integrationTests() : [...unit(), ...integrationTests()];
  status = runNodeTests(files);
}
if ((scope === 'e2e' || scope === 'all') && status === 0) {
  buildWorkspace('daemon');
  // Several e2e scripts run the CLI's built entry (packages/cli/dist/cli.js).
  buildWorkspace('cli');
  for (const [script, ...args] of e2e) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', env: hermeticEnv() });
    if (result.status !== 0) { status = result.status ?? 1; break; }
  }
}
process.exitCode = status;
