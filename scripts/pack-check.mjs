#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
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

for (const location of manifest.workspaces) {
  const pkg = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  const result = spawnSync('npm', ['pack', '--workspace', pkg.name, '--dry-run', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) { console.error(result.stdout + result.stderr); process.exit(result.status ?? 1); }
  // npm lifecycle progress appears before the JSON array on some npm versions.
  const start = result.stdout.indexOf('[\n');
  const packed = JSON.parse(result.stdout.slice(start >= 0 ? start : 0))[0];
  const files = new Set(packed.files.map(file => file.path));
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
  console.log(`${pkg.name}@${pkg.version}: ${files.size} packed files, public exports verified`);
}
