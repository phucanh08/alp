#!/usr/bin/env node
// Consumer verification on a saved release (docs/alp/beta-scope.md §6.3, §7.2): installs exactly the
// eight tarballs in the release directory, never packs or builds them again, and proves that what
// got installed is those files:
//   1. A5 (release-verify) passes on the directory, and the CLI's alp web files are in its tarballs;
//   2. a fresh project installs the eight tarballs; its package-lock.json resolves every @anhlp/*
//      package to a local file with the manifest's integrity, at the release version, gateway absent;
//   3. tarball-consumer.mjs and package-smoke.mjs run against the same files (--packs);
//   4. afterwards the tarballs still match SHA256SUMS.
//
//   release-consumer.mjs <directory> [--rehearsal] [--install-only]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';
import { RELEASE_NAMES, installedProblems, shippedWebProblems, verifyRelease } from './release-lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); if (index >= 0) args.splice(index, 1); return index >= 0; };
const rehearsal = flag('--rehearsal');
const installOnly = flag('--install-only');
if (args.length !== 1) throw new Error('Usage: release-consumer.mjs <directory> [--rehearsal] [--install-only]');
const directory = path.resolve(args[0]);

function verified(stage) {
  const result = verifyRelease(directory, { rehearsal });
  if (result.problems.length) throw new Error(`${stage}: A5 failed for ${directory}:\n- ${result.problems.join('\n- ')}`);
  return result;
}

const before = verified('before install');
// The saved tarballs carry what `alp web` runs (alp-web.js, its app, their notices); checked beside A5.
const missingWeb = before.artifacts.flatMap(artifact => shippedWebProblems(artifact.name, artifact.files.keys()));
if (missingWeb.length) throw new Error(`the saved tarballs cannot run alp web:\n- ${missingWeb.join('\n- ')}`);
const work = mkdtempSync(path.join(os.tmpdir(), 'alp-release-consumer-'));
try {
  writeFileSync(path.join(work, 'package.json'), `${JSON.stringify({ name: 'alp-release-consumer', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`);
  const install = spawnSync(...spawnCommand('npm', ['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', ...before.artifacts.map(artifact => artifact.file)]), { cwd: work, stdio: 'inherit' });
  if (install.status !== 0) throw new Error(`npm install of the saved tarballs exited ${install.status}`);
  const problems = installedProblems(JSON.parse(readFileSync(path.join(work, 'package-lock.json'), 'utf8')), before.manifest);
  if (problems.length) throw new Error(`the consumer did not install the saved tarballs:\n- ${problems.join('\n- ')}`);
  console.log(`[release-consumer] installed the ${RELEASE_NAMES.length} saved tarballs; lockfile integrity matches ${path.basename(directory)}/release-manifest.json`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
if (!installOnly) {
  for (const script of ['tarball-consumer.mjs', 'package-smoke.mjs']) {
    console.log(`\n[release-consumer] ${script} --packs ${directory}`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), '--packs', directory], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${script} on the saved tarballs exited ${result.status}`);
  }
}
const after = verified('after the consumer checks');
const changed = after.artifacts.filter(artifact => before.artifacts.find(entry => entry.name === artifact.name)?.sha256 !== artifact.sha256);
if (changed.length) throw new Error(`tarballs changed during the checks: ${changed.map(artifact => artifact.filename).join(', ')}`);
console.log(`[release-consumer] passed${installOnly ? ' (install only: tarball-consumer and package-smoke not run)' : ''} on ${before.manifest.version} from ${before.manifest.git?.sha ?? 'no commit'}, artifacts ${before.manifest.sha256sums}${rehearsal ? ' — REHEARSAL: not gate evidence' : ''}.`);
