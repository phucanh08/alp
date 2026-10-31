#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const [workspace, version] = process.argv.slice(2);
if (!workspace || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) throw new Error('Usage: npm run version:package -- <package-name> <semver>');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packages = await Promise.all(manifest.workspaces.map(async location => ({ location, manifest: JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8')) })));
const selected = packages.find(pkg => pkg.manifest.name === workspace);
if (!selected || selected.manifest.private) throw new Error('Select a publishable workspace by its full npm name');
selected.manifest.version = version;
for (const pkg of packages) {
  if (pkg.manifest.dependencies?.[workspace]) pkg.manifest.dependencies[workspace] = version;
  await writeFile(path.join(root, pkg.location, 'package.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
}
// npm/alp (the @anhlp/alp wrapper) is not a workspace: it pins @anhlp/alp-cli exactly and ships at the same version.
const wrapperPath = path.join(root, 'npm/alp/package.json');
const wrapper = JSON.parse(await readFile(wrapperPath, 'utf8'));
if (wrapper.dependencies?.[workspace]) {
  wrapper.dependencies[workspace] = version;
  wrapper.version = version;
  await writeFile(wrapperPath, `${JSON.stringify(wrapper, null, 2)}\n`);
}
if (manifest.dependencies?.[workspace]) {
  manifest.dependencies[workspace] = version;
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const result = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
