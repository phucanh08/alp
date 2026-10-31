#!/usr/bin/env node
// Smoke test of install + `alp update` (t-1807) with a built bundle against local release mirrors: a
// file:// mirror and a loopback HTTP mirror holding this platform's archive and SHA256SUMS (packed by
// scripts/package-binary.mjs). The bundle is installed into a throwaway root by install.sh (POSIX) or
// install.ps1 (Windows); then --check, the update-template hint, --yes, a corrupted SHA256SUMS that
// must change nothing, and reinstalls of the running version that switch app/current.
//
//   node scripts/binary-update-smoke.mjs [dist/bundle/alp-<version>-<platform>]
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pack, sums } from './package-binary.mjs';
import { hostPlatform } from './build-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const version = JSON.parse(await readFile(path.join(ROOT, 'packages/cli/package.json'), 'utf8')).version;
const bundle = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist/bundle', `alp-${version}-${hostPlatform()}`));
if (!existsSync(path.join(bundle, 'alp-bundle.json'))) throw new Error(`${bundle} is not a built bundle; build it with node scripts/build-bundle.mjs`);
const log = message => console.log(`[binary-update-smoke] ${message}`);
const check = (condition, message) => { if (!condition) throw new Error(message); log(`ok: ${message}`); };
const exec = promisify(execFile);
const work = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-update-smoke-')));
const user = path.join(work, 'user');
const env = { ...process.env, HOME: user, USERPROFILE: user, ALP_HOME: path.join(work, 'alp-home'), ALP_UPDATE_NO_GH: '1', SHELL: '/bin/sh' };
delete env.ALP_UPDATE_BASE_URL;
/** Runs a command; never throws: returns { code, stdout, stderr }. */
const runCmd = (file, args, options = {}) => exec(file, args, { env, timeout: 300_000, ...options }).then(r => ({ code: 0, ...r }), e => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const root = path.join(work, 'root');
const app = path.join(root, 'app');
const bin = path.join(work, 'bin');
const installed = path.join(bin, windows ? 'alp.cmd' : 'alp');
const alp = args => runCmd(installed, args, { shell: windows });
const current = () => windows ? readlinkSync(path.join(app, 'current')) : readlinkSync(path.join(app, 'current'));
const versions = () => readdirSync(app).sort();

let server;
try {
  await mkdir(user);
  await mkdir(env.ALP_HOME, { mode: 0o700 });
  // This Node may run under another architecture than the bundle (x64 Node under Rosetta): the
  // mirror holds the same bundle under both architecture names of this OS.
  const mirror = path.join(work, 'mirror');
  await pack({ bundle, out: mirror });
  if (!windows) {
    const platform = JSON.parse(await readFile(path.join(bundle, 'alp-bundle.json'), 'utf8')).platform;
    const [osName, arch] = platform.split('-');
    const other = `alp-${version}-${osName}-${arch === 'x64' ? 'arm64' : 'x64'}.tar.gz`;
    await copyFile(path.join(mirror, `alp-${version}-${platform}.tar.gz`), path.join(mirror, other));
  }
  await copyFile(path.join(ROOT, 'install.sh'), path.join(mirror, 'install.sh'));
  await copyFile(path.join(ROOT, 'install.ps1'), path.join(mirror, 'install.ps1'));
  await sums(mirror);
  const fileUrl = pathToFileURL(mirror).href;

  // Install, as a user would.
  const install = windows
    ? await runCmd('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install.ps1'), '-BaseUrl', fileUrl, '-Dir', bin, '-Root', root, '-NoModifyPath'])
    : await runCmd('sh', [path.join(ROOT, 'install.sh'), '--base-url', mirror, '--dir', bin, '--root', root, '--no-modify-path']);
  check(install.code === 0, `the installer installs the bundle (${install.stdout}${install.stderr})`);
  check(existsSync(path.join(app, version, 'alp-bundle.json')), `app/${version} holds the bundle`);
  let r = await alp(['--version']);
  check(r.code === 0 && r.stdout.trim() === version, `the installed alp runs (${r.stdout.trim()} ${r.stderr.trim()})`);

  r = await alp(['update', '--check', '--base-url', fileUrl]);
  check(r.code === 0 && /up to date/.test(r.stdout), `alp update --check reports ${version} up to date (${r.code} ${r.stdout}${r.stderr})`);
  r = await alp(['update', '.']);
  check(r.code === 1 && /did you mean `alp update-template`/.test(r.stderr), 'a template-style argument gets the update-template hint');
  r = await alp(['update', '--version', version, '--base-url', fileUrl]);
  check(r.code !== 0 && /pass --yes/.test(r.stderr), 'without a terminal, alp update needs --yes');

  // A corrupted SHA256SUMS: refused, nothing changed.
  const bad = path.join(work, 'bad');
  await mkdir(bad);
  for (const name of (await readFile(path.join(mirror, 'SHA256SUMS'), 'utf8')).trim().split('\n').map(line => line.split(/\s+\*?/)[1])) await copyFile(path.join(mirror, name), path.join(bad, name));
  await writeFile(path.join(bad, 'SHA256SUMS'), (await readFile(path.join(mirror, 'SHA256SUMS'), 'utf8')).replace(/^[0-9a-f]{64}/gm, '0'.repeat(64)));
  const before = versions();
  r = await alp(['update', '--yes', '--version', version, '--base-url', pathToFileURL(bad).href]);
  check(r.code !== 0 && /Checksum mismatch/.test(r.stderr), 'a checksum mismatch is refused');
  check(JSON.stringify(versions()) === JSON.stringify(before), `the refused update changed nothing in app/ (${versions().join(', ')})`);

  // file:// mirror: a reinstall of the running version puts a fresh copy at app/<version>.
  r = await alp(['update', '--yes', '--version', version, '--base-url', fileUrl]);
  check(r.code === 0 && /Checksum verified/.test(r.stdout) && /Updated ALP/.test(r.stdout), `alp update --yes from a file:// mirror (${r.stderr.trim() || 'ok'})`);
  check(/only the SHA256SUMS checksum was verified/.test(r.stderr), 'without gh it warns that only the checksum was verified');
  check(versions().some(name => name.startsWith('.alp-old-')), `the running copy was kept aside (${versions().join(', ')})`);
  check(path.basename(current()) === version, `app/current points at ${version}`);
  check((await alp(['--version'])).stdout.trim() === version, 'the reinstalled alp runs');

  // Loopback HTTP mirror; the previous aside copy is pruned now.
  server = http.createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname.split('/').pop());
    try { response.end(await readFile(path.join(mirror, path.basename(name)))); } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  r = await alp(['update', '--yes', '--version', version, '--base-url', `http://127.0.0.1:${server.address().port}/v${version}`]);
  check(r.code === 0 && /Updated ALP/.test(r.stdout), `alp update --yes from a loopback HTTP mirror (${r.stderr.trim() || 'ok'})`);
  check(versions().filter(name => name.startsWith('.alp-old-')).length === 1, `only the latest aside copy is kept (${versions().join(', ')})`);
  check((await alp(['--version'])).stdout.trim() === version, 'alp still runs after the HTTP update');

  // install.sh again (an upgrade of an existing install) keeps one version and the command.
  if (!windows) {
    r = await runCmd('sh', [path.join(ROOT, 'install.sh'), '--base-url', mirror, '--dir', bin, '--root', root, '--no-modify-path']);
    check(r.code === 0 && (await alp(['--version'])).stdout.trim() === version, 'rerunning install.sh over an install works');
  }
  log('ok');
} finally {
  server?.close();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
