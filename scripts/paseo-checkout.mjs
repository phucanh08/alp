#!/usr/bin/env node
// Checks out the sources of Paseo's plugin compiler at a pinned commit, for scripts/paseo-source-check.mjs
// (issue #111): it compiles the packed plugin with Paseo's own compiler, as `paseo plugin add npm:…` does.
// A new checkout has only packages/server/src/server/plugins (sparse, blobs on demand): no install, no build.
// The checkout lives in .cache/paseo-src, or in $ALP_PASEO_SRC when that names one.
//
// The pin is Paseo 0.11.2, the commit ALP's removed Paseo web app (paseo-web, t-55ce.3) was built from
// and the compiler #111 was checked against. Move it with care: the plugin must stay installable by
// the oldest Paseo that requirements.paseo admits.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnCommand } from './spawn-command.mjs';

export const PASEO_UPSTREAM = { repository: 'https://github.com/getpaseo/paseo.git', commit: 'b63a325be3d3ae444fbd38815658cca01ab1288f', version: '0.11.2' };
export const PASEO_COMPILER_DIRECTORY = 'packages/server/src/server/plugins';
const ROOT = path.resolve(import.meta.dirname, '..');
export const paseoSource = () => path.resolve(process.env.ALP_PASEO_SRC ?? path.join(ROOT, '.cache/paseo-src'));

function git(args, cwd) {
  console.log(`$ git ${args.join(' ')}`);
  const result = spawnSync(...spawnCommand('git', args), { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal})`);
}
const quiet = (args, cwd) => spawnSync(...spawnCommand('git', args), { cwd, encoding: 'utf8' }).stdout?.trim() ?? '';

/** The checkout at the pinned commit, with only the compiler's directory; returns its path. */
export function checkoutPaseo(source = paseoSource()) {
  if (!existsSync(path.join(source, '.git'))) {
    mkdirSync(path.dirname(source), { recursive: true });
    git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', PASEO_UPSTREAM.repository, source], ROOT);
    // Only a checkout made here is narrowed; one $ALP_PASEO_SRC names keeps its own sparseness.
    git(['sparse-checkout', 'set', '--no-cone', `/${PASEO_COMPILER_DIRECTORY}/`], source);
  }
  if (quiet(['cat-file', '-t', PASEO_UPSTREAM.commit], source) !== 'commit') git(['fetch', '--quiet', '--filter=blob:none', 'origin', PASEO_UPSTREAM.commit], source);
  git(['checkout', '--quiet', '--force', '--detach', PASEO_UPSTREAM.commit], source);
  if (!existsSync(path.join(source, PASEO_COMPILER_DIRECTORY, 'compiler.ts'))) throw new Error(`no ${PASEO_COMPILER_DIRECTORY}/compiler.ts in ${source} at ${PASEO_UPSTREAM.commit}`);
  return source;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const source = checkoutPaseo();
  console.log(`Paseo ${PASEO_UPSTREAM.version} (${PASEO_UPSTREAM.commit.slice(0, 7)}) plugin compiler in ${path.relative(ROOT, source) || source}`);
}
