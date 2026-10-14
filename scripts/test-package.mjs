#!/usr/bin/env node
// `npm test` inside one workspace: build the package and the workspaces it depends on, then run
// only the tests in packages/<name>/tests. They import the package and its declared dependencies,
// never a sibling that depends on them (scripts/check-boundaries.mjs enforces that).
import { buildWorkspace, packageTests, packages, runNodeTests } from './test-lib.mjs';

const name = process.argv[2] === 'paseo-plugin' ? 'paseo' : process.argv[2];
if (!packages.includes(name)) throw new Error(`Usage: test-package.mjs <${packages.join('|')}>`);
const files = packageTests(name);
if (!files.length) {
  console.log(`${name}: no package tests (its contract is covered by test/integration)`);
  process.exit(0);
}
buildWorkspace(name);
process.exitCode = runNodeTests(files);
