#!/usr/bin/env node
// @ts-check
// CI only: rewrites this checkout so integrations/paseo builds and tests against another Paseo SDK
// release (t-e5dc). Never commit its result.
//
//   node scripts/use-paseo-sdk.mjs floor    the lowest release requirements.paseo admits
//   node scripts/use-paseo-sdk.mjs latest   the latest published release
//   node scripts/use-paseo-sdk.mjs 0.12.0   an exact release
//   node scripts/use-paseo-sdk.mjs --verify after pnpm install: the installed SDK is the pinned one
//
// It pins the four @getpaseo/* devDependencies of @anhlp/alp-paseo to that version and refreshes
// pnpm-lock.yaml only. Run `pnpm install --frozen-lockfile` next; --verify then checks that the
// hoisted layout put them at the root, where tests in test/ resolve them, not nested under
// integrations/paseo.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SDK = ['@getpaseo/plugin', '@getpaseo/client', '@getpaseo/protocol', '@getpaseo/relay'];

/** @param {string} command @param {string[]} args @returns {string} */
function run(command, args) {
  const result = spawnSync(...spawnCommand(command, args), { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

const target = process.argv[2];
if (target === '--verify' && process.argv.length === 3) {
  // A lane must test the release it names: fail if pnpm placed another copy where the code resolves it.
  const pinned = JSON.parse(readFileSync(path.join(ROOT, 'integrations/paseo/package.json'), 'utf8')).devDependencies;
  const wrong = [];
  for (const name of SDK) {
    for (const where of ['node_modules', 'integrations/paseo/node_modules']) {
      const file = path.join(ROOT, where, name, 'package.json');
      if (!existsSync(file)) continue;
      const { version } = JSON.parse(readFileSync(file, 'utf8'));
      if (version !== pinned[name]) wrong.push(`${where}/${name} is ${version}, pinned ${pinned[name]}`);
    }
    if (!existsSync(path.join(ROOT, 'node_modules', name, 'package.json'))) wrong.push(`${name} is not installed at the root, where test/ resolves it`);
  }
  if (wrong.length) throw new Error(`installed Paseo SDK differs from the pins:\n- ${wrong.join('\n- ')}`);
  console.log(`installed Paseo SDK matches the pins: ${SDK.map(name => `${name}@${pinned[name]}`).join(', ')}`);
  process.exit(0);
}
if (!target || process.argv.length > 3) throw new Error('Usage: use-paseo-sdk.mjs <floor|latest|version|--verify>');
let version = target;
if (target === 'floor') version = run(process.execPath, ['scripts/check-paseo-compat.mjs', '--floor']);
if (target === 'latest') version = JSON.parse(run('npm', ['view', '@getpaseo/plugin', 'dist-tags.latest', '--json']));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);

const manifestFile = path.join(ROOT, 'integrations/paseo/package.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
for (const name of SDK) manifest.devDependencies[name] = version;
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

run('pnpm', ['install', '--lockfile-only', '--ignore-scripts']);
console.log(`integrations/paseo now uses Paseo SDK ${version} (${SDK.join(', ')}); run pnpm install --frozen-lockfile next.`);
