#!/usr/bin/env node
import { nativeSlots, verifyTerminalNative } from './terminal-native-assets.mjs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';
import { corePackageProblems } from './core-package-boundary.mjs';
import { THIRD_PARTY_NOTICES, packageDirectory, packageName } from './third-party-notices.mjs';
import { LAUNCHER, LAUNCHER_LOCATION, launcherProblems, shippedWebProblems } from './release-lib.mjs';
const root = path.resolve(import.meta.dirname, '..');
await verifyTerminalNative({ requireMatrix: true });
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** Files matched by an export target; a bare target is a single lookup, `*` is a pattern. */
function expand(target, files) {
  const pattern = target.replace(/^\.\//, '');
  if (!pattern.includes('*')) return files.has(pattern) ? [pattern] : [];
  const star = pattern.indexOf('*');
  return [...files].filter(file => file.startsWith(pattern.slice(0, star)) && file.endsWith(pattern.slice(star + 1)) && file.length >= pattern.length - 1);
}

/** The substring a file contributes to the `*` of the pattern that matched it. */
function capture(pattern, file) {
  const star = pattern.indexOf('*');
  return file.slice(star, file.length - (pattern.length - star - 1));
}

const REPOSITORY = 'git+https://github.com/phucanh08/alp.git';
const read = file => readFile(path.join(root, file), 'utf8');
const [rootLicense, rootNotice] = await Promise.all([read('LICENSE'), read('NOTICE')]);

/**
 * ALP is Apache-2.0: every tarball carries the root LICENSE and NOTICE (the plugin's NOTICE adds
 * Paseo's attribution), names the repository it is built from, and lists in a THIRD-PARTY-NOTICES.txt
 * every package esbuild inlined into its JavaScript (found from esbuild's `// <path>` module comments).
 */
async function licenceProblems(location, pkg, files) {
  const problems = [];
  const at = file => path.posix.join(location, file);
  if (pkg.license !== 'Apache-2.0') problems.push(`${pkg.name}: license is ${pkg.license}, not Apache-2.0`);
  if (pkg.repository?.url !== REPOSITORY || (pkg.repository?.directory ?? '.') !== location) problems.push(`${pkg.name}: repository is not ${REPOSITORY} (directory ${location})`);
  if (!files.has('LICENSE') || (await read(at('LICENSE'))) !== rootLicense) problems.push(`${pkg.name}: LICENSE missing or not the root LICENSE`);
  const notice = files.has('NOTICE') ? await read(at('NOTICE')) : '';
  if (pkg.name === '@anhlp/alp-paseo' ? !notice.startsWith(rootNotice) || !notice.includes('Mohamed Boudra') : notice !== rootNotice) problems.push(`${pkg.name}: NOTICE missing or not ALP's`);
  const notices = (await Promise.all([...files].filter(file => file.endsWith(THIRD_PARTY_NOTICES)).map(file => read(at(file))))).join('\n');
  const bundled = new Set();
  for (const file of [...files].filter(file => file.endsWith('.js'))) {
    for (const [, comment] of (await read(at(file))).matchAll(/^\/\/ (\S+)$/gm)) {
      const directory = packageDirectory(comment);
      if (directory) bundled.add(packageName(directory));
    }
  }
  for (const name of bundled) if (!notices.includes(`\n${name}@`)) problems.push(`${pkg.name}: bundles ${name} but no ${THIRD_PARTY_NOTICES} lists it`);
  // The plugin's bridge carries code taken from Paseo: Paseo's licence ships with it.
  if (pkg.name === '@anhlp/alp-paseo' && !files.has('LICENSE.paseo.txt')) problems.push(`${pkg.name}: no LICENSE.paseo.txt`);
  // Paseo's web app was removed (t-55ce.3); a checkout that built it before still has it in server/dist.
  if ([...files].some(file => file.startsWith('server/dist/web-app/'))) problems.push(`${pkg.name}: carries a stale server/dist/web-app (Paseo's removed web app); delete it and pack again`);
  return problems;
}

// The workspaces and the npm wrapper (npm/alp, outside the workspaces).
for (const location of ['.', ...manifest.workspaces, LAUNCHER_LOCATION]) {
  const pkg = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  const result = spawnSync(...spawnCommand('npm', ['pack', ...(location === LAUNCHER_LOCATION ? [`./${location}`] : ['--workspace', pkg.name]), '--dry-run', '--json', ...(process.argv.includes('--ignore-scripts') ? ['--ignore-scripts'] : [])]), { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) { console.error(result.stdout + result.stderr); process.exit(result.status ?? 1); }
  // npm lifecycle progress appears before the JSON array on some npm versions.
  const start = result.stdout.indexOf('[\n');
  const packed = JSON.parse(result.stdout.slice(start >= 0 ? start : 0))[0];
  const files = new Set(packed.files.map(file => file.path));
  const nativeDirectory = ({ '@anhlp/alp-daemon': 'dist/terminal-native', '@anhlp/alp-cli': 'dist/terminal-native', '@anhlp/alp-paseo': 'server/dist/terminal-native' })[pkg.name];
  if (nativeDirectory) for (const slot of nativeSlots) for (const name of ['terminal-owner', 'manifest.json']) {
    if (!files.has(`${nativeDirectory}/prebuilt/${slot}/${name}`)) throw new Error(`${pkg.name}: missing shipped native ${slot}/${name}`);
  }
  if (pkg.name !== '@anhlp/alp-paseo') {
    const problems = corePackageProblems(pkg, [...files]);
    if (problems.length) throw new Error(problems.join('\n'));
  }
  for (const entry of Object.values(pkg.exports ?? {})) {
    const targets = [entry.default, entry.types].filter(Boolean);
    for (const target of targets) {
      if (!expand(target, files).length) throw new Error(`${pkg.name}: public export ${target} missing from tarball`);
    }
    // A wildcard export pair must carry real declarations for every concrete JavaScript artifact.
    if (entry.default?.includes('*') && entry.types?.includes('*')) {
      for (const file of expand(entry.default, files)) {
        const expected = entry.types.replace(/^\.\//, '').replace('*', capture(entry.default.replace(/^\.\//, ''), file));
        if (!files.has(expected)) throw new Error(`${pkg.name}: declaration ${expected} missing for packed export ${file}`);
      }
    }
  }
  for (const bin of Object.values(pkg.bin ?? {})) if (!files.has(bin)) throw new Error(`${pkg.name}: missing executable ${bin}`);
  const problems = [...await licenceProblems(location, pkg, files), ...shippedWebProblems(pkg.name, files), ...(pkg.name === LAUNCHER ? launcherProblems(pkg, manifest.version) : [])];
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`${pkg.name}@${pkg.version}: ${files.size} packed files, public exports and licences verified`);
}
