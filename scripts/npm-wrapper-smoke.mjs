#!/usr/bin/env node
// The npm wrapper as a user gets it (t-1807): `npm install -g` of @anhlp/alp and the JavaScript
// packages it depends on into a throwaway prefix, then npm's `alp`: --version, init, and update
// (which only says to update with npm). With a release directory (release-pack.mjs) it installs
// those saved tarballs; without one it packs the built workspaces and npm/alp (--ignore-scripts).
// HOME, ALP_HOME and the npm cache are throwaway too; nothing global is touched.
//
//   node scripts/npm-wrapper-smoke.mjs [<release directory>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';
import { LAUNCHER, LAUNCHER_LOCATION, RELEASE_PACKAGES, releaseArtifacts } from './release-lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const work = mkdtempSync(path.join(os.tmpdir(), 'alp-npm-wrapper-'));
const prefix = path.join(work, 'prefix');
const home = path.join(work, 'home');
const env = { ...process.env, HOME: home, USERPROFILE: home, ALP_HOME: path.join(home, '.alp'), npm_config_prefix: prefix, npm_config_cache: path.join(work, 'npm-cache'), npm_config_userconfig: path.join(work, 'npmrc'), npm_config_update_notifier: 'false' };

function run(command, args, options = {}) {
  const result = spawnSync(...spawnCommand(command, args), { cwd: work, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`);
  return result.stdout;
}

try {
  mkdirSync(env.ALP_HOME, { recursive: true, mode: 0o700 });
  let tarballs;
  if (process.argv[2]) {
    tarballs = releaseArtifacts(path.resolve(process.argv[2])).map(artifact => artifact.file);
  } else {
    const packs = path.join(work, 'packs');
    mkdirSync(packs);
    tarballs = RELEASE_PACKAGES.map(({ name, kind }) => {
      const where = kind === 'launcher' ? [`./${LAUNCHER_LOCATION}`] : ['--workspace', name];
      const output = run('npm', ['pack', ...where, '--ignore-scripts', '--json', '--pack-destination', packs], { cwd: root });
      const start = output.search(/^\[/m);
      return path.join(packs, JSON.parse(output.slice(start >= 0 ? start : 0))[0].filename);
    });
  }
  // The local tarballs satisfy @anhlp/alp's pinned @anhlp/alp-cli and its @anhlp/* dependencies,
  // so nothing of ALP's comes from the registry.
  run('npm', ['install', '-g', '--no-audit', '--no-fund', ...tarballs]);
  const bin = process.platform === 'win32' ? path.join(prefix, 'alp.cmd') : path.join(prefix, 'bin', 'alp');
  if (!existsSync(bin)) throw new Error(`npm install -g made no ${bin}`);
  // @anhlp/alp-cli declares bin alp too: the command must be the wrapper's.
  if (process.platform !== 'win32' && !realpathSync(bin).endsWith(path.join('@anhlp', 'alp', 'bin', 'alp.js'))) throw new Error(`${bin} is ${realpathSync(bin)}, not @anhlp/alp's bin/alp.js`);
  if (process.platform === 'win32' && !/@anhlp[\\/]alp[\\/]bin[\\/]alp\.js/.test(readFileSync(bin, 'utf8'))) throw new Error(`${bin} does not run @anhlp/alp's bin/alp.js`);
  const alp = (...args) => run(bin, args, process.platform === 'win32' ? { shell: true } : {});

  const printed = alp('--version').trim();
  if (printed !== version) throw new Error(`alp --version printed ${JSON.stringify(printed)}, expected ${version}`);
  const project = path.join(work, 'project');
  alp('init', project);
  if (!existsSync(path.join(project, '.alp'))) throw new Error(`alp init made no ${path.join(project, '.alp')}`);
  const update = alp('update');
  if (!update.includes(`npm install -g ${LAUNCHER}@beta`)) throw new Error(`alp update outside the bundle must say to update with npm; printed:\n${update}`);
  console.log(`[npm-wrapper-smoke] npm install -g ${LAUNCHER}@${version} (${tarballs.length} tarballs): alp --version, alp init and alp update work`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
