#!/usr/bin/env node
// Source check before packing (docs/alp/beta-scope.md §1, §2): exactly the release packages (the
// platform packages are generated when packing) are public, every one at the release version, internal dependencies pinned to it, and
// package-lock.json in step. Usage: release-check.mjs [--version <semver>] (default: root version).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LAUNCHER_LOCATION, RELEASE_PACKAGES, sourceProblems } from './release-lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const at = args.indexOf('--version');
if (args.length !== (at >= 0 ? 2 : 0) || (at >= 0 && !args[at + 1])) throw new Error('Usage: release-check.mjs [--version <semver>]');
const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const manifest = readJson('package.json');
const version = at >= 0 ? args[at + 1] : manifest.version;
const workspaces = ['.', ...manifest.workspaces, LAUNCHER_LOCATION].map(location => ({ location, pkg: location === '.' ? manifest : readJson(path.join(location, 'package.json')) }));
const problems = sourceProblems({ workspaces, lock: readJson('package-lock.json'), version });
if (problems.length) {
  console.error(`Release source check failed for ${version}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Release source check passed: ${RELEASE_PACKAGES.filter(pkg => pkg.kind !== 'platform').length} public packages (and ${RELEASE_PACKAGES.filter(pkg => pkg.kind === 'platform').length} generated platform packages) at ${version}, internal dependencies pinned, lockfile in step; every other workspace private.`);
