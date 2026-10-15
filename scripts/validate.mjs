#!/usr/bin/env node
// Shared local/CI baseline. Every child failure stops this lane with a nonzero exit code.
import { spawnSync } from 'node:child_process';
import { ROOT, buildAll, buildWorkspace, integrationTests, packageTests, packages, runNodeTests } from './test-lib.mjs';

const scope = process.argv[2] ?? 'all';
if (!['all', 'core', 'paseo', 'packages'].includes(scope) || process.argv.length > 3) {
  throw new Error('Usage: validate.mjs [all|core|paseo|packages]');
}
function node(script, ...args) {
  console.log(`\n[validate:${scope}] ${script} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function tests(files) {
  const status = runNodeTests(files);
  if (status !== 0) process.exit(status);
}
if (scope === 'all' || scope === 'core') {
  node('scripts/check-boundaries.mjs');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.core.json');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.gateway.json');
  buildWorkspace('daemon');
  buildWorkspace('cli');
  node('scripts/build-core.mjs');
  node('scripts/check-boundaries.mjs', '--require-artifacts');
  tests(packages.filter(name => name !== 'paseo').flatMap(packageTests));
  node('scripts/core-standalone-smoke.mjs');
}
if (scope === 'all' || scope === 'paseo') {
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.paseo.json');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json');
  buildAll();
  tests(packageTests('paseo'));
  tests(integrationTests());
}
if (scope === 'all' || scope === 'packages') {
  node('scripts/build-paseo-web.mjs');
  buildAll();
  node('scripts/check-web-app.mjs');
  node('scripts/check-boundaries.mjs', '--require-artifacts');
  // Inspect the artifacts just built; lifecycle rebuilds could conceal missing outputs.
  node('scripts/pack-check.mjs', '--ignore-scripts');
  node('scripts/tarball-consumer.mjs');
  node('scripts/package-smoke.mjs');
  node('scripts/gateway-smoke.mjs');
}
