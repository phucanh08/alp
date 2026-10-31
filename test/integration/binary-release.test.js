// t-1807: the release archive layout (the ALP bundle), SHA256SUMS, install.sh against a file:// mirror,
// and the process.execPath lint. The real bundle is smoked by scripts/binary-*smoke*.{mjs,sh} in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { archiveName, pack, sums } from '../../scripts/package-binary.mjs';
import { namesExecPath } from '../../scripts/execpath-lint.mjs';
import { fakeBundle } from '../support/fake-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL = path.join(ROOT, 'install.sh');
const posix = process.platform !== 'win32';
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

async function temp(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A release mirror: one archive per platform for each version, SHA256SUMS and install.sh. */
async function mirror(t, versions = ['9.8.7']) {
  const out = await temp(t, 'alp-mirror-');
  for (const version of versions) {
    const work = await temp(t, 'alp-bundles-');
    for (const platform of PLATFORMS) await pack({ bundle: await fakeBundle(work, version, platform), out });
  }
  await copyFile(INSTALL, path.join(out, 'install.sh'));
  await sums(out);
  return out;
}

/** Runs install.sh with a private HOME and a PATH without the install directory. */
function install(args, { home, shell = '/bin/sh', extraEnv = {} }) {
  return new Promise(resolve => execFile('/bin/sh', [INSTALL, ...args], {
    env: { HOME: home, SHELL: shell, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...extraEnv }, timeout: 60_000,
  }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}

test('the release archive holds the bundle directory alp-<version>-<os>-<arch>/', { skip: !posix }, async t => {
  const bundle = await fakeBundle(await temp(t, 'alp-bundle-'), '1.2.3', 'linux-arm64');
  const out = await temp(t, 'alp-pack-');
  const archive = await pack({ bundle, out });
  assert.equal(path.basename(archive), 'alp-1.2.3-linux-arm64.tar.gz');
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').map(line => line.replace(/\/$/, ''));
  for (const name of ['alp-bundle.json', 'bin/alp', 'node/bin/node', 'lib/node_modules/@anhlp/alp-cli/dist/cli.js', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) assert.ok(listing.includes(`alp-1.2.3-linux-arm64/${name}`), name);
  assert.throws(() => archiveName('1.0.0', 'windows-arm64'), /No release archive/);
  assert.equal(archiveName('1.0.0', 'windows-x64'), 'alp-1.0.0-windows-x64');
  assert.throws(() => archiveName('../1', 'linux-x64'), /Invalid version/);
  await sums(out);
  const line = (await readFile(path.join(out, 'SHA256SUMS'), 'utf8')).trim();
  assert.match(line, /^[0-9a-f]{64} {2}alp-1\.2\.3-linux-arm64\.tar\.gz$/);
});

test('install.sh installs the latest release to ~/.alp/app/<version>, links ~/.alp/bin/alp through app/current, and adds a PATH line once', { skip: !posix }, async t => {
  const releases = await mirror(t);
  const home = await temp(t, 'alp-home-');
  // An ALP 0.0.1-beta.5/6 single-file install: install.sh replaces it with the link.
  await mkdir(path.join(home, '.alp/bin'), { recursive: true });
  await writeFile(path.join(home, '.alp/bin/alp'), 'old single-file alp');
  const first = await install(['--base-url', pathToFileURL(releases).href], { home });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /checksum verified/);
  assert.match(first.stdout, /\n9\.8\.7\n$/, 'it runs alp --version last');
  assert.equal(await readlink(path.join(home, '.alp/bin/alp')), path.join(home, '.alp/app/current/bin/alp'));
  assert.equal(await readlink(path.join(home, '.alp/app/current')), '9.8.7');
  assert.equal(execFileSync(path.join(home, '.alp/bin/alp'), ['--version'], { encoding: 'utf8' }).trim(), '9.8.7');
  assert.equal(execFileSync(path.join(home, '.alp/bin/alp'), ['a', 'b c'], { encoding: 'utf8' }).trim(), '["a","b c"]', 'arguments pass through the launcher');
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt', 'alp-bundle.json']) assert.ok(existsSync(path.join(home, '.alp/app/9.8.7', file)), file);
  const profile = await readFile(path.join(home, '.profile'), 'utf8');
  assert.ok(profile.includes('export PATH="$HOME/.alp/bin:$PATH"'), profile);
  const again = await install(['--base-url', pathToFileURL(releases).href], { home });
  assert.equal(again.code, 0, again.stderr);
  assert.equal((await readFile(path.join(home, '.profile'), 'utf8')).split('$HOME/.alp/bin').length, 2, 'the PATH line is added only once');
  // zsh and fish get their own profile files.
  const zsh = await install(['--base-url', releases], { home, shell: '/bin/zsh', extraEnv: { ALP_INSTALL_BASE_URL: 'file:///nowhere' } });
  assert.equal(zsh.code, 0, zsh.stderr);
  assert.ok((await readFile(path.join(home, '.zshrc'), 'utf8')).includes('export PATH="$HOME/.alp/bin:$PATH"'));
  const fish = await install([], { home, shell: '/usr/bin/fish', extraEnv: { ALP_INSTALL_BASE_URL: pathToFileURL(releases).href } });
  assert.equal(fish.code, 0, fish.stderr);
  assert.ok((await readFile(path.join(home, '.config/fish/conf.d/alp.fish'), 'utf8')).includes('fish_add_path "$HOME/.alp/bin"'));
});

test('install.sh --version picks that release, --dir/--root install elsewhere, --no-modify-path only prints the line; an upgrade keeps the previous version', { skip: !posix }, async t => {
  const releases = await mirror(t, ['1.0.0', '1.1.0-beta.2']);
  const home = await temp(t, 'alp-home-');
  const dir = path.join(home, 'tools/bin');
  const root = path.join(home, 'tools/alp');
  const result = await install(['--version', 'v1.1.0-beta.2', '--dir', dir, '--root', root, '--no-modify-path', '--base-url', releases], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(execFileSync(path.join(dir, 'alp'), ['--version'], { encoding: 'utf8' }).trim(), '1.1.0-beta.2');
  assert.ok((await lstat(path.join(root, 'app/current'))).isSymbolicLink());
  // 1.0.0, then back to 1.1.0-beta.2, then 1.0.0 again: only current and the previous version stay.
  for (const version of ['1.0.0', '1.1.0-beta.2', '1.0.0']) {
    const step = await install(['--version', version, '--dir', dir, '--root', root, '--no-modify-path', '--base-url', releases], { home });
    assert.equal(step.code, 0, step.stderr);
    assert.equal(execFileSync(path.join(dir, 'alp'), ['--version'], { encoding: 'utf8' }).trim(), version);
  }
  assert.deepEqual((await readdir(path.join(root, 'app'))).filter(name => !name.startsWith('.')).sort(), ['1.0.0', '1.1.0-beta.2', 'current']);
  assert.match(result.stdout, /is not on PATH; add it with:\n {2}export PATH="\$HOME\/tools\/bin:\$PATH"/);
  assert.equal(existsSync(path.join(home, '.profile')), false, '--no-modify-path edits no profile');
  // Two versions in one SHA256SUMS: "latest" is ambiguous and refused rather than guessed.
  const ambiguous = await install(['--base-url', releases], { home });
  assert.notEqual(ambiguous.code, 0);
  assert.match(ambiguous.stderr, /more than one/);
  const missing = await install(['--version', '2.0.0', '--base-url', releases], { home });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /no build for/);
});

test('install.sh --root alone puts the command in <root>/bin and leaves HOME and its profiles untouched; --modify-path opts back in (t-37f1)', { skip: !posix }, async t => {
  const releases = await mirror(t);
  const home = await temp(t, 'alp-home-');
  const root = path.join(await temp(t, 'alp-root-'), 'alp');
  const result = await install(['--root', root, '--base-url', releases], { home, shell: '/bin/zsh' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readlink(path.join(root, 'bin/alp')), path.join(root, 'app/current/bin/alp'));
  assert.equal(execFileSync(path.join(root, 'bin/alp'), ['--version'], { encoding: 'utf8' }).trim(), '9.8.7');
  assert.deepEqual(await readdir(home), [], 'nothing in HOME: no ~/.alp/bin, no .zshrc');
  assert.match(result.stdout, /is not on PATH; add it with:/);
  const opted = await install(['--root', root, '--modify-path', '--base-url', releases], { home, shell: '/bin/zsh' });
  assert.equal(opted.code, 0, opted.stderr);
  assert.ok((await readFile(path.join(home, '.zshrc'), 'utf8')).includes(`export PATH="${path.join(root, 'bin')}:$PATH"`));
  assert.equal(existsSync(path.join(home, '.alp')), false);
});

test('install.sh refuses a corrupted archive, a malformed SHA256SUMS, bad options and versions, and installs nothing', { skip: !posix }, async t => {
  const releases = await mirror(t);
  const home = await temp(t, 'alp-home-');
  const name = (await readFile(path.join(releases, 'SHA256SUMS'), 'utf8')).match(/alp-9\.8\.7-[a-z]+-[a-z0-9]+\.tar\.gz/g);
  for (const archive of name) await writeFile(path.join(releases, archive), 'corrupted');
  const corrupted = await install(['--base-url', releases], { home });
  assert.notEqual(corrupted.code, 0);
  assert.match(corrupted.stderr, /checksum mismatch/);
  assert.equal(existsSync(path.join(home, '.alp/bin/alp')), false);
  await writeFile(path.join(releases, 'SHA256SUMS'), (await readFile(path.join(releases, 'SHA256SUMS'), 'utf8')).replace(/^[0-9a-f]{64}/gm, 'xyz'));
  const malformed = await install(['--base-url', releases], { home });
  assert.match(malformed.stderr, /malformed checksum/);
  const unknown = await install(['--frobnicate'], { home });
  assert.match(unknown.stderr, /unknown option/);
  const version = await install(['--version', '1.0;rm -rf /'], { home });
  assert.match(version.stderr, /invalid version/);
  const absent = await install(['--base-url', pathToFileURL(path.join(releases, 'none')).href], { home });
  assert.match(absent.stderr, /could not download/);
  assert.equal(existsSync(path.join(home, '.alp/bin/alp')), false);
  const injected = await install(['--dir', `${home}/a"; touch pwned; "`, '--base-url', releases], { home });
  assert.match(injected.stderr, /unsupported characters in --dir/);
  const http = await install(['--base-url', 'http://example.invalid/r'], { home });
  assert.match(http.stderr, /must be https:\/\/ or file:\/\//);
  const empty = await install(['--version', 'v'], { home });
  assert.match(empty.stderr, /--version needs a value/);
  const help = await install(['--help'], { home });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: install\.sh/);
});

test('the execPath lint catches property and element access and destructuring of process.execPath', () => {
  const hits = text => {
    const source = ts.createSourceFile('x.mjs', text, ts.ScriptTarget.Latest, true);
    let count = 0;
    (function visit(node) { if (namesExecPath(node)) count++; ts.forEachChild(node, visit); })(source);
    return count;
  };
  assert.equal(hits('spawn(process.execPath, [x]);'), 1);
  assert.equal(hits("spawn(process['execPath'], [x]); spawn(process[`execPath`]);"), 2);
  assert.equal(hits('const { execPath } = process; const { execPath: bin } = process; const { "execPath": q } = globalThis.process;'), 3);
  assert.equal(hits('globalThis.process.execPath;'), 1);
  assert.equal(hits("import { execPath } from 'node:process'; import { execPath as e } from 'process'; import { execPath as f } from 'other';"), 2);
  assert.equal(hits("import * as p from 'node:process'; import q from 'process'; p.execPath; q.execPath; const r = {}; r.execPath;"), 2);
  assert.equal(hits('const { argv } = process; other.execPath; process.argv0; const { execPath } = other;'), 0);
});

test('build-bundle pins exactly the third-party packages the lockfile holds at one version', async () => {
  const { lockedVersions } = await import('../../scripts/build-bundle.mjs');
  const pins = lockedVersions({ packages: {
    '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/@s/b': { version: '2.0.0' },
    'node_modules/c': { version: '1.0.0' }, 'node_modules/x/node_modules/c': { version: '2.0.0' },
    'node_modules/@anhlp/alp-core': { link: true }, 'packages/cli/node_modules/a': { version: '1.0.0' }, 'node_modules/@anhlp/alp-gateway': { version: '1.0.0' },
  } });
  assert.deepEqual(Object.fromEntries(pins), { a: '1.0.0', '@s/b': '2.0.0' });
});
