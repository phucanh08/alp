#!/usr/bin/env node
// Shared local/CI baseline. Every child failure stops this lane with a nonzero exit code.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './spawn-command.ts';
import { ROOT, assertTypeStripping, buildAll, buildWorkspace, clearCallerSession, integrationTests, packageTests, packages, runNodeTests, webTests } from './test-lib.ts';

assertTypeStripping('scripts/validate.ts');

const scope = process.argv[2] ?? 'all';
if (!['all', 'core', 'paseo', 'packages', 'web'].includes(scope) || process.argv.length > 3) {
  throw new Error('Usage: validate.ts [all|core|paseo|packages|web]');
}
// t-5294.3 / t-3a63: this lane checks what the USER's install does, so it must not run as the agent
// whose shell happened to start it. An inherited ALP_AGENT_SESSION made every child announce itself
// as an agent, and the user-only guards then refused the very steps being checked: `alp dashboard --print`
// in core-standalone-smoke.ts (:138) answered "alp dashboard is the user's" instead of the expected
// missing-bundle error, and tarball-consumer.ts's installed-plugin regressions answered "Only the
// user answers a question". So no agent could run validate:core or validate:packages at all, and
// every "validated locally" from an agent needed a footnote. The guards are product behaviour and
// are unchanged; what is removed here is the caller's session, once, for every step below, which
// spawn without an env of their own and so inherit this one.
const cleared = clearCallerSession();
if (cleared.length) console.log(`[validate:${scope}] cleared the caller's ALP session variables, so every step runs as the user would: ${cleared.join(', ')}`);
/** The commit this run checks, and whether the checkout differs from it, so a gate log names what it ran on. */
function commit() {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0 || !head.stdout.trim()) return 'commit unknown (not a git checkout)';
  const changes = git('status', '--porcelain', '--untracked-files=no');
  return `commit ${head.stdout.trim()}${changes.status !== 0 ? ' (uncommitted changes unknown)' : changes.stdout.trim() ? ' with uncommitted changes' : ''}`;
}
console.log(`[validate:${scope}] ${commit()}`);
function node(script: string, ...args: string[]) {
  console.log(`\n[validate:${scope}] ${script} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function pnpm(...args: string[]) {
  console.log(`\n[validate:${scope}] pnpm ${args.join(' ')}`);
  const result = spawnSync(...spawnCommand('pnpm', args), { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function tests(files: string[]) {
  const status = runNodeTests(files);
  if (status !== 0) process.exit(status);
}
if (scope === 'all' || scope === 'core') {
  node('scripts/check-boundaries.ts');
  // t-5294.6: a t.after that removes a directory, registered before the one closing what lives in
  // it, hangs the whole file to the per-file watchdog when the removal throws. Static, so it runs
  // before the long steps.
  node('scripts/check-teardown-order.ts');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.core.json');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.gateway.json');
  // The scripts and the root tests themselves: strict TypeScript that Node runs directly
  // (scripts/tsconfig.json and test/tsconfig.json; pnpm run check:scripts and check:test).
  node('node_modules/typescript/bin/tsc', '-p', 'scripts/tsconfig.json');
  node('node_modules/typescript/bin/tsc', '-p', 'test/tsconfig.json');
  buildWorkspace('daemon');
  buildWorkspace('cli');
  // The gateway is only a devDependency of the CLI, so building the CLI does not build it; its tests
  // and the CLI's dashboard tests import its default export, which is its built dist.
  buildWorkspace('gateway');
  node('scripts/build-core.ts');
  node('scripts/check-boundaries.ts', '--require-artifacts');
  tests(packages.filter(name => name !== 'paseo').flatMap(packageTests));
  node('scripts/core-standalone-smoke.ts');
}
if (scope === 'all' || scope === 'paseo') {
  // The host's requirements.paseo and the @getpaseo/* peers are one range that admits the installed SDK (t-e5dc).
  node('scripts/check-paseo-compat.ts');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.paseo.json');
  node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json');
  buildAll();
  tests(packageTests('paseo'));
  tests(integrationTests());
}
if (scope === 'all' || scope === 'packages') {
  // The pinned sources of Paseo's plugin compiler, for tarball-consumer's #111 check below.
  node('scripts/paseo-checkout.ts');
  buildAll();
  node('scripts/check-boundaries.ts', '--require-artifacts');
  // The client SDK as installed from its tarballs: entries import, the portable entries bundle for a
  // browser with nothing from Node, and the declarations type-check (t-0ec1). Its browser and metro
  // modes need Playwright and Metro and stay manual.
  node('scripts/client-sdk-smoke.ts', 'tarball');
  // Inspect the artifacts just built; lifecycle rebuilds could conceal missing outputs.
  node('scripts/pack-check.ts', '--ignore-scripts');
  // The release path (docs/alp/beta-scope.md §7.2): pack the tarballs once into a new
  // directory with SHA256SUMS and a manifest, then run A5 and every consumer check (installed
  // integrity, tarball-consumer, package-smoke, npm-wrapper-smoke) on those saved files. A rehearsal:
  // CI is untagged.
  const release = mkdtempSync(path.join(os.tmpdir(), 'alp-release-'));
  // paseo-checkout.ts made the pinned Paseo checkout above: tarball-consumer must run Paseo's own
  // plugin compiler on the npm:-style install (scripts/paseo-source-check.ts, #111), not skip it.
  process.env.ALP_REQUIRE_PASEO_COMPILER = '1';
  node('scripts/release-check.ts');
  node('scripts/release-pack.ts', '--out', release, '--rehearsal', '--ignore-scripts');
  node('scripts/release-consumer.ts', release, '--rehearsal');
  // The npm wrapper as users install it: npm install -g of the saved tarballs, then npm's alp.
  node('scripts/npm-wrapper-smoke.ts', release);
  rmSync(release, { recursive: true, force: true });
  node('scripts/gateway-smoke.ts');
}
if (scope === 'all' || scope === 'web') {
  // The browser app (docs/alp/dashboard.md): types, unit tests and its bundle boundary, then the UI end
  // to end against a real alpd and gateway with a fake provider, in Chromium.
  // The app and its unit tests import @anhlp/alp-client, whose default export is its built dist.
  buildWorkspace('client');
  // Its unit tests load src/lib built into apps/web/dist-lib.
  node('apps/web/scripts/build-lib.ts');
  node('node_modules/typescript/bin/tsc', '-p', 'apps/web/tsconfig.json');
  tests(webTests());
  // pretest:e2e in apps/web builds the CLI, daemon and app bundle first.
  pnpm('--filter', '@anhlp/alp-web', 'run', 'test:e2e');
}
