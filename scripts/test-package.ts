#!/usr/bin/env node
// `pnpm test` inside one workspace: build the package and the workspaces it depends on, then run
// only the tests in packages/<name>/tests. They import the package and its declared dependencies,
// never a sibling that depends on them (scripts/check-boundaries.ts enforces that).
import { buildWorkspace, packageTests, packages, runNodeTests } from './test-lib.ts';

/**
 * Workspaces a package's tests drive through the shared test/support helpers without depending on
 * them: the client's golden output (tests/golden.test.ts) runs a tree on the runtime
 * (test/support/fake-agent.ts), so a fresh checkout builds it first. The CLI's dashboard tests
 * import the gateway, only a devDependency of the CLI, whose default export is its built dist.
 */
const testSupport: Record<string,string[]> = { client: ['runtime'], cli: ['gateway'] };

// --private-home is still accepted and changes nothing: runNodeTests always gives a throwaway
// HOME/USERPROFILE without caller ALP_*_BIN (t-bfbd, t-a87f).
const privateHome = process.argv.includes('--private-home');
const [argument] = process.argv.slice(2).filter(arg => arg !== '--private-home');
const name = argument === 'paseo-plugin' ? 'paseo' : argument;
if (!packages.includes(name)) throw new Error(`Usage: test-package.ts <${packages.join('|')}>`);
const files = packageTests(name);
if (!files.length) {
  console.log(`${name}: no package tests (its contract is covered by test/integration)`);
  process.exit(0);
}
buildWorkspace(name);
for (const support of testSupport[name] ?? []) buildWorkspace(support);
process.exitCode = runNodeTests(files, { privateHome });
