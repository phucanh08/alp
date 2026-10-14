#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
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
    for (const target of [entry.default, entry.types].filter(Boolean)) {
      if (!files.has(target.replace(/^\.\//, ''))) throw new Error(`${pkg.name}: public export ${target} missing from tarball`);
    }
  }
  for (const bin of Object.values(pkg.bin ?? {})) if (!files.has(bin)) throw new Error(`${pkg.name}: missing executable ${bin}`);
  console.log(`${pkg.name}@${pkg.version}: ${files.size} packed files, public exports verified`);
}
