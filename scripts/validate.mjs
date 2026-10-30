#!/usr/bin/env node
// Shared local/CI baseline. Every child failure stops this lane with a nonzero exit code.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';
import { ROOT, buildAll, buildWorkspace, integrationTests, packageTests, packages, runNodeTests, webTests } from './test-lib.mjs';

const scope = process.argv[2] ?? 'all';
if (!['all', 'core', 'paseo', 'packages', 'web'].includes(scope) || process.argv.length > 3) {
  throw new Error('Usage: validate.mjs [all|core|paseo|packages|web]');
}
/** The commit this run checks, and whether the checkout differs from it, so a gate log names what it ran on. */
function commit() {
  const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0 || !head.stdout.trim()) return 'commit unknown (not a git checkout)';
  const changes = git('status', '--porcelain', '--untracked-files=no');
  return `commit ${head.stdout.trim()}${changes.status !== 0 ? ' (uncommitted changes unknown)' : changes.stdout.trim() ? ' with uncommitted changes' : ''}`;
}
console.log(`[validate:${scope}] ${commit()}`);
function node(script, ...args) {
  console.log(`\n[validate:${scope}] ${script} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function npm(...args) {
  console.log(`\n[validate:${scope}] npm ${args.join(' ')}`);
  const result = spawnSync(...spawnCommand('npm', args), { cwd: ROOT, stdio: 'inherit' });
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
  // The host's requirements.paseo and the @getpaseo/* peers are one range that admits the installed SDK (t-e5dc).
  node('scripts/check-paseo-compat.mjs');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.paseo.json');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json');
  buildAll();
  tests(packageTests('paseo'));
  tests(integrationTests());
}
if (scope === 'all' || scope === 'packages') {
  // The pinned sources of Paseo's plugin compiler, for tarball-consumer's #111 check below.
  node('scripts/paseo-checkout.mjs');
  buildAll();
  node('scripts/check-boundaries.mjs', '--require-artifacts');
  // Inspect the artifacts just built; lifecycle rebuilds could conceal missing outputs.
  node('scripts/pack-check.mjs', '--ignore-scripts');
  // The release path (docs/alp/beta-scope.md §7.2): pack the eight tarballs once into a new
  // directory with SHA256SUMS and a manifest, then run A5 and every consumer check (installed
  // integrity, tarball-consumer, package-smoke) on those saved files. A rehearsal: CI is untagged.
  const release = mkdtempSync(path.join(os.tmpdir(), 'alp-release-'));
  // paseo-checkout.mjs made the pinned Paseo checkout above: tarball-consumer must run Paseo's own
  // plugin compiler on the npm:-style install (scripts/paseo-source-check.mjs, #111), not skip it.
  process.env.ALP_REQUIRE_PASEO_COMPILER = '1';
  node('scripts/release-check.mjs');
  node('scripts/release-pack.mjs', '--out', release, '--rehearsal', '--ignore-scripts');
  node('scripts/release-consumer.mjs', release, '--rehearsal');
  rmSync(release, { recursive: true, force: true });
  node('scripts/gateway-smoke.mjs');
}
if (scope === 'all' || scope === 'web') {
  // The browser app (docs/alp/web.md): types, unit tests and its bundle boundary, then the UI end
  // to end against a real alpd and gateway with a fake provider, in Chromium.
  node('node_modules/typescript/bin/tsc', '-p', 'apps/web/tsconfig.json');
  tests(webTests());
  // pretest:e2e in apps/web builds the CLI, daemon and app bundle first.
  npm('run', 'test:e2e', '--workspace', '@anhlp/alp-web');
}
