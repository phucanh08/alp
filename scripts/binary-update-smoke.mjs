#!/usr/bin/env node
// Smoke test of `alp update` (t-1e02 P3) with the built executable against local release mirrors:
// a file:// mirror and a loopback HTTP mirror holding this platform's archive and SHA256SUMS (packed
// by scripts/package-binary.mjs), a corrupted SHA256SUMS that must replace nothing, --check, and the
// update-template hint. On Windows it also checks the alp.exe → alp.old.exe rename and its cleanup.
//
//   node scripts/binary-update-smoke.mjs [path/to/alp]
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pack, sums } from './package-binary.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const binary = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist/bin', windows ? 'alp.exe' : 'alp'));
if (!existsSync(binary)) throw new Error(`${binary} is missing; build it with node scripts/build-binary.mjs`);
const log = message => console.log(`[binary-update-smoke] ${message}`);
const check = (condition, message) => { if (!condition) throw new Error(message); log(`ok: ${message}`); };
const exec = promisify(execFile);
const work = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-update-smoke-')));
const env = { ...process.env, ALP_HOME: path.join(work, 'home'), ALP_UPDATE_NO_GH: '1' };
delete env.ALP_UPDATE_BASE_URL;
/** Runs the installed alp; never throws: returns { code, stdout, stderr }. */
const alp = (file, args) => exec(file, args, { env, timeout: 120_000 }).then(r => ({ code: 0, ...r }), e => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const identity = file => { const s = statSync(file); return `${s.ino}:${s.mtimeMs}:${s.birthtimeMs}`; };

let server;
try {
  await mkdir(env.ALP_HOME, { mode: 0o700 });
  const version = (await exec(binary, ['--version'], { env })).stdout.trim();
  // This Node may run under another architecture than the executable (x64 Node under Rosetta): the
  // mirror holds the same executable under both architecture names of this OS.
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const mirror = path.join(work, 'mirror');
  for (const arch of windows ? ['x64'] : ['x64', 'arm64']) await pack({ binary, target: `bun-${osName}-${arch}`, out: mirror, version });
  await sums(mirror);
  const fileUrl = pathToFileURL(mirror).href;
  const bin = path.join(work, 'bin');
  await mkdir(bin);
  const installed = path.join(bin, windows ? 'alp.exe' : 'alp');
  await copyFile(binary, installed);

  let r = await alp(installed, ['update', '--check', '--base-url', fileUrl]);
  check(r.code === 0 && /up to date/.test(r.stdout), `alp update --check reports ${version} up to date (${r.code} ${r.stdout}${r.stderr})`);

  r = await alp(installed, ['update', '.']);
  check(r.code === 1 && /did you mean `alp update-template`/.test(r.stderr), 'a template-style argument gets the update-template hint');

  r = await alp(installed, ['update', '--version', version, '--base-url', fileUrl]);
  check(r.code !== 0 && /pass --yes/.test(r.stderr), 'without a terminal, alp update needs --yes');

  // A corrupted SHA256SUMS: refused, nothing replaced, nothing left beside the executable.
  const bad = path.join(work, 'bad');
  await mkdir(bad);
  for (const name of (await readFile(path.join(mirror, 'SHA256SUMS'), 'utf8')).trim().split('\n').map(line => line.split(/\s+\*?/)[1])) await copyFile(path.join(mirror, name), path.join(bad, name));
  await writeFile(path.join(bad, 'SHA256SUMS'), (await readFile(path.join(mirror, 'SHA256SUMS'), 'utf8')).replace(/^[0-9a-f]{64}/gm, '0'.repeat(64)));
  const before = identity(installed);
  r = await alp(installed, ['update', '--yes', '--version', version, '--base-url', pathToFileURL(bad).href]);
  check(r.code !== 0 && /Checksum mismatch/.test(r.stderr), 'a checksum mismatch is refused');
  check(identity(installed) === before, 'the refused update left the executable in place');
  check((await import('node:fs')).readdirSync(bin).join(',') === path.basename(installed), 'the refused update left no staged file');

  // file:// mirror: the executable is replaced by the archive's copy.
  r = await alp(installed, ['update', '--yes', '--version', version, '--base-url', fileUrl]);
  check(r.code === 0 && /Checksum verified/.test(r.stdout) && /Updated /.test(r.stdout), `alp update --yes from a file:// mirror (${r.stderr.trim() || 'ok'})`);
  check(/only the SHA256SUMS checksum was verified/.test(r.stderr), 'without gh it warns that only the checksum was verified');
  check(identity(installed) !== before, 'the executable file was replaced');
  if (windows) {
    const old = path.join(bin, 'alp.old.exe');
    check(existsSync(old), 'Windows: the previous alp.exe was renamed to alp.old.exe');
    const v = await alp(installed, ['--version']);
    check(v.code === 0 && v.stdout.trim() === version, 'Windows: the new alp.exe runs');
    for (let i = 0; i < 50 && existsSync(old); i++) await new Promise(resolve => setTimeout(resolve, 100));
    check(!existsSync(old), 'Windows: the next start deleted alp.old.exe');
  } else {
    check((await alp(installed, ['--version'])).stdout.trim() === version, 'the new executable runs');
  }

  // Loopback HTTP mirror.
  server = http.createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname.split('/').pop());
    try { response.end(await readFile(path.join(mirror, path.basename(name)))); } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const httpUrl = `http://127.0.0.1:${server.address().port}/v${version}`;
  const beforeHttp = identity(installed);
  r = await alp(installed, ['update', '--yes', '--version', version, '--base-url', httpUrl]);
  check(r.code === 0 && /Updated /.test(r.stdout), `alp update --yes from a loopback HTTP mirror (${r.stderr.trim() || 'ok'})`);
  check(identity(installed) !== beforeHttp, 'the HTTP update replaced the executable');
  check((await alp(installed, ['--version'])).stdout.trim() === version, 'the executable still runs after the HTTP update');
  log('ok');
} finally {
  server?.close();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
