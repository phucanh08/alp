#!/usr/bin/env node
// The npm install of ALP on this machine (t-cd7f): packs this machine's platform package from its
// release archive and the @anhlp/alp launcher (npm/alp), installs both globally into a temporary
// prefix as `npm install -g` would, and runs `alp --version` and `alp init` through npm's own `alp`
// (a symlink on POSIX, alp.cmd on Windows). The other platform packages are not published, so npm
// skips them as unavailable optional dependencies. Called by binary-build.yml on every target.
//
//   node scripts/npm-launcher-smoke.mjs <dir with this platform's alp-<version>-<platform> archive>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packPlatforms, npmPack } from './npm-platform.mjs';
import { hostPlatformName } from './release-lib.mjs';
import { spawnCommand } from './spawn-command.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const binaries = path.resolve(process.argv[2] ?? 'dist/release');
const version = JSON.parse(readFileSync(path.join(ROOT, 'npm/alp/package.json'), 'utf8')).version;
const host = hostPlatformName();
if (!host) throw new Error(`no ALP platform package for ${process.platform}-${process.arch}`);
const work = mkdtempSync(path.join(os.tmpdir(), 'alp-npm-launcher-'));
try {
  const packs = path.join(work, 'packs');
  mkdirSync(packs);
  const [{ packed, binary }] = await packPlatforms({ binaries, version, out: packs, only: [host.replace('@anhlp/alp-', '')] });
  const launcher = npmPack(path.join(ROOT, 'npm/alp'), packs);
  console.log(`${packed.filename}: ${packed.size} bytes (executable ${binary.binarySha256} from ${binary.archive}); ${launcher.filename}: ${launcher.size} bytes`);
  const prefix = path.join(work, 'prefix');
  const run = (command, args, options = {}) => {
    const result = spawnSync(...spawnCommand(command, args), { encoding: 'utf8', timeout: 300_000, ...options });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`);
    return result.stdout;
  };
  run('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', path.join(packs, launcher.filename), path.join(packs, packed.filename)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const windows = process.platform === 'win32';
  const modules = windows ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  const executable = path.join(modules, host, 'bin', windows ? 'alp.exe' : 'alp');
  if (!windows && !(statSync(executable).mode & 0o111)) throw new Error(`${executable} is not executable after install`);
  const alp = windows ? path.join(prefix, 'alp.cmd') : path.join(prefix, 'bin', 'alp');
  const home = path.join(work, 'home');
  mkdirSync(home, { mode: 0o700 });
  // alp.cmd is a batch file, which Node starts only through a shell (CVE-2024-27980).
  const env = { ...process.env, ALP_HOME: home };
  const shell = windows;
  const printed = run(alp, ['--version'], { env, shell }).trim();
  if (printed !== version) throw new Error(`alp --version through the launcher printed ${JSON.stringify(printed)}, expected ${version}`);
  const project = path.join(work, 'project');
  mkdirSync(project);
  run(alp, ['init', project], { env, shell });
  statSync(path.join(project, 'ALP.md'));
  const update = run(alp, ['update'], { env, shell });
  if (!/installed with npm; update it with npm/.test(update)) throw new Error(`alp update through npm must say to update with npm:\n${update}`);
  const unknown = spawnSync(...spawnCommand(alp, ['no-such-command']), { env, shell, encoding: 'utf8', timeout: 60_000 });
  if (unknown.status === 0) throw new Error('alp no-such-command exited 0 through the launcher');
  console.log(`npm launcher smoke passed on ${host}: alp --version ${printed}, alp init, alp update (npm message), exit ${unknown.status} passed through`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
