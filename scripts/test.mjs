#!/usr/bin/env node
// Root test entry: `unit` (every packages/*/tests), `integration` (test/integration), `e2e`
// (test/e2e, live providers, opt-in) or `all`. Without an argument it runs the hermetic suites,
// unit and integration together in one `node --test` run, so no file executes twice.
import { spawnSync } from 'node:child_process';
import { ROOT, buildAll, buildWorkspace, integrationTests, packageTests, packages, runNodeTests } from './test-lib.mjs';

const scope = process.argv[2] ?? 'hermetic';
const usage = 'Usage: test.mjs [unit|integration|e2e|hermetic|all]';
if (!['unit', 'integration', 'e2e', 'hermetic', 'all'].includes(scope)) throw new Error(usage);

// Live e2e suites call real providers and, for some, a running Paseo host.
const e2e = [
  ['test/e2e/workflow-e2e.mjs', 'pho'], ['test/e2e/workflow-e2e.mjs', 'cafe'],
  ['test/e2e/mailbox-e2e.mjs', 'ask'], ['test/e2e/mailbox-e2e.mjs', 'wake'], ['test/e2e/mailbox-e2e.mjs', 'steer'],
  ['test/e2e/team-e2e.mjs'], ['test/e2e/claude-e2e.mjs'], ['test/e2e/claude-runtime-e2e.mjs'],
  ['test/e2e/paseo-e2e.mjs'], ['test/e2e/alpd-e2e.mjs'], ['test/e2e/viewer-detach-e2e.mjs'], ['test/e2e/persistence-e2e.mjs'],
  ['test/e2e/import-e2e.mjs'], ['test/e2e/worktree-e2e.mjs'], ['test/e2e/human-e2e.mjs', 'cli'], ['test/e2e/human-e2e.mjs', 'paseo'], ['test/e2e/board-e2e.mjs'],
];
const unit = () => packages.flatMap(name => packageTests(name));

let status = 0;
if (scope !== 'e2e') {
  buildAll();
  const files = scope === 'unit' ? unit() : scope === 'integration' ? integrationTests() : [...unit(), ...integrationTests()];
  status = runNodeTests(files);
}
if ((scope === 'e2e' || scope === 'all') && status === 0) {
  buildWorkspace('daemon');
  for (const [script, ...args] of e2e) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0) { status = result.status ?? 1; break; }
  }
}
process.exitCode = status;
