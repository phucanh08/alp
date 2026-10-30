import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  allowedHop, cleanupOldExecutable, retryBusy, compareVersions, fetchBytes, npmMessage, oldPath, releaseBaseUrl, releasePlatform, replaceExecutable,
  selectAsset, selfUpdate, sha256, verifyChecksum, verifyProvenance,
} from '../src/self-update.js';

const H = c => c.repeat(64);
const SUMS = [
  `${H('a')}  alp-1.2.0-darwin-arm64.tar.gz`,
  `${H('b')}  alp-1.2.0-darwin-x64.tar.gz`,
  `${H('c')} *alp-1.2.0-linux-x64.tar.gz`,
  `${H('d')}  alp-1.2.0-linux-arm64.tar.gz`,
  `${H('e')}  alp-1.2.0-windows-x64.zip`,
  `${H('f')}  install.sh`,
].join('\n');

test('asset selection picks this os/arch from SHA256SUMS and reads the version from its name', () => {
  assert.equal(releasePlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(releasePlatform('linux', 'x64'), 'linux-x64');
  assert.equal(releasePlatform('win32', 'x64'), 'windows-x64');
  assert.throws(() => releasePlatform('win32', 'arm64'), /no executable/);
  assert.throws(() => releasePlatform('freebsd', 'x64'), /no executable/);
  assert.deepEqual(selectAsset(SUMS, 'linux-x64'), { sha256: H('c'), name: 'alp-1.2.0-linux-x64.tar.gz', version: '1.2.0' });
  assert.deepEqual(selectAsset(SUMS, 'windows-x64'), { sha256: H('e'), name: 'alp-1.2.0-windows-x64.zip', version: '1.2.0' });
  assert.equal(selectAsset(SUMS, 'darwin-arm64', '1.2.0').sha256, H('a'));
  assert.throws(() => selectAsset(SUMS, 'darwin-arm64', '1.3.0'), /no ALP executable for darwin-arm64 at version 1.3.0/);
  assert.throws(() => selectAsset(`${SUMS}\n${H('9')}  alp-1.1.0-linux-x64.tar.gz`, 'linux-x64'), /more than one/);
  assert.throws(() => selectAsset('nonsense', 'linux-x64'), /Malformed/);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.0.1-beta.5', '0.0.1-beta.10'), -1);
  assert.equal(compareVersions('0.0.1', '0.0.1-beta.5'), 1);
  assert.equal(compareVersions('1.0.0+b7', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.x.0', '1.0.0'), /Invalid version/);
});

test('the release mirror must be https, file or loopback http', () => {
  assert.equal(releaseBaseUrl({ repo: 'o/r' }), 'https://github.com/o/r/releases/latest/download');
  assert.equal(releaseBaseUrl({ repo: 'o/r', version: '1.2.0' }), 'https://github.com/o/r/releases/download/v1.2.0');
  assert.equal(releaseBaseUrl({ repo: 'o/r', baseUrl: 'http://127.0.0.1:9/m/' }), 'http://127.0.0.1:9/m');
  assert.match(releaseBaseUrl({ repo: 'o/r', baseUrl: path.resolve('/tmp/mirror') }), /^file:\/\//);
  assert.throws(() => releaseBaseUrl({ repo: 'o/r', baseUrl: 'http://example.com/m' }), /https:\/\/ or file:\/\//);
});

/** A fetch that serves `routes`: url → [status, location] for a redirect, or a body string. */
const fakeFetch = (routes, seen = []) => async (url, init) => {
  seen.push(url);
  assert.equal(init.redirect, 'manual');
  const route = routes[url];
  if (route === undefined) return new Response('missing', { status: 404 });
  if (Array.isArray(route)) return new Response(null, { status: route[0], headers: { location: route[1] } });
  return new Response(route);
};

test('every redirect hop of a download must be https; only an explicit loopback http mirror may use loopback http', async () => {
  assert.equal(allowedHop('https://github.com/a', 'https://objects.githubusercontent.com/b'), true);
  assert.equal(allowedHop('https://github.com/a', 'http://objects.githubusercontent.com/b'), false);
  assert.equal(allowedHop('https://github.com/a', 'http://127.0.0.1/b'), false);
  assert.equal(allowedHop('http://127.0.0.1:9/a', 'http://localhost:9/b'), true);
  assert.equal(allowedHop('http://127.0.0.1:9/a', 'http://example.com/b'), false);
  assert.equal(allowedHop('http://127.0.0.1:9/a', 'https://example.com/b'), true);
  const ok = await fetchBytes('https://a.test/x', { fetch: fakeFetch({ 'https://a.test/x': [302, 'https://b.test/y'], 'https://b.test/y': [307, '/z'], 'https://b.test/z': 'payload' }) });
  assert.equal(new TextDecoder().decode(ok), 'payload');
  // https → http → https: refused at the http hop, which is never requested.
  const seen = [];
  await assert.rejects(fetchBytes('https://a.test/x', { fetch: fakeFetch({ 'https://a.test/x': [302, 'http://mitm.test/y'], 'http://mitm.test/y': [302, 'https://b.test/z'], 'https://b.test/z': 'evil' }, seen) }), /redirected to http:\/\/mitm\.test\/y, which is not https; refused/);
  assert.deepEqual(seen, ['https://a.test/x']);
  await assert.rejects(fetchBytes('http://example.com/x', { fetch: fakeFetch({}) }), /not https/);
  await assert.rejects(fetchBytes('https://a.test/loop', { fetch: fakeFetch({ 'https://a.test/loop': [302, 'https://a.test/loop'] }) }), /more than 10 times/);
  await assert.rejects(fetchBytes('https://a.test/big', { max: 4, fetch: fakeFetch({ 'https://a.test/big': 'too large' }) }), /larger than 4 bytes/);
  await assert.rejects(fetchBytes('https://a.test/none', { fetch: fakeFetch({}) }), /HTTP 404/);
});

test('a checksum mismatch is refused', () => {
  const bytes = new TextEncoder().encode('archive');
  assert.equal(verifyChecksum(bytes, { name: 'a', sha256: sha256(bytes) }), sha256(bytes));
  assert.throws(() => verifyChecksum(bytes, { name: 'alp-1.2.0-linux-x64.tar.gz', sha256: H('0') }), /Checksum mismatch for alp-1.2.0-linux-x64.tar.gz.*nothing was replaced/);
});

test('provenance: gh absent warns, gh present runs attestation verify with the release workflow and refuses a failure', () => {
  assert.equal(verifyProvenance('/x.tar.gz', { repo: 'o/r', find: () => undefined }), 'unavailable');
  assert.equal(verifyProvenance('/x.tar.gz', { repo: 'o/r', env: { ALP_UPDATE_NO_GH: '1' }, find: () => '/bin/gh' }), 'unavailable');
  const calls = [];
  assert.equal(verifyProvenance('/x.tar.gz', { repo: 'o/r', env: {}, find: () => '/bin/gh', run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; } }), 'verified');
  assert.deepEqual(calls[0], ['/bin/gh', 'attestation', 'verify', '/x.tar.gz', '--repo', 'o/r', '--source-ref', 'refs/heads/main', '--signer-workflow', 'o/r/.github/workflows/release-binaries.yml']);
  assert.throws(() => verifyProvenance('/x.tar.gz', { repo: 'o/r', env: {}, find: () => '/bin/gh', run: () => ({ status: 1, stderr: 'no attestations' }) }), /gh attestation verify refused x.tar.gz: no attestations/);
});

/** An in-memory filesystem with the calls it saw. */
function memoryFs(files, { failRename, locked = new Set() } = {}) {
  const calls = [];
  return {
    calls, files,
    existsSync: f => files.has(f),
    readdirSync: dir => [...files.keys()].filter(f => path.win32.dirname(f) === dir).map(f => path.win32.basename(f)),
    rmSync: f => { calls.push(['rm', f]); if (locked.has(f)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); files.delete(f); },
    renameSync: (from, to) => {
      calls.push(['rename', from, to]);
      if (failRename?.(from, to) || (locked.has(from) && failRename === 'locked')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      if (!files.has(from)) throw Object.assign(new Error(`ENOENT ${from}`), { code: 'ENOENT' });
      files.set(to, files.get(from)); files.delete(from);
    },
  };
}

test('Windows: the running alp.exe becomes alp.old.exe, the new one takes its name, .old goes on the next start', () => {
  const target = path.win32.join('C:\\Users\\u\\.alp\\bin', 'alp.exe');
  const staged = 'C:\\Users\\u\\.alp\\bin\\.alp.update.1.exe';
  const old = oldPath(target, 'win32');
  assert.equal(path.win32.basename(old), 'alp.old.exe');
  const fs = memoryFs(new Map([[target, 'v1'], [staged, 'v2'], [old, 'v0']]));
  assert.deepEqual(replaceExecutable(staged, target, { platform: 'win32', fs, sleep: () => {} }), { old });
  assert.deepEqual(fs.calls, [['rm', old], ['rename', target, old], ['rename', staged, target]]);
  assert.equal(fs.files.get(target), 'v2');
  assert.equal(fs.files.get(old), 'v1');
  assert.equal(cleanupOldExecutable(target, { platform: 'win32', fs }), true);
  assert.equal(fs.files.has(old), false);
  assert.equal(cleanupOldExecutable(target, { platform: 'win32', fs }), false);
  assert.equal(cleanupOldExecutable(target, { platform: 'darwin', fs }), false);
});

test('Windows: a failed second rename puts the old executable back', () => {
  const target = 'C:\\bin\\alp.exe', staged = 'C:\\bin\\.alp.update.2.exe';
  const fs = memoryFs(new Map([[target, 'v1'], [staged, 'v2']]), { failRename: (from) => from === staged });
  assert.throws(() => replaceExecutable(staged, target, { platform: 'win32', fs, sleep: () => {} }), /EBUSY/);
  assert.equal(fs.files.get(target), 'v1');
  assert.equal(fs.files.has(oldPath(target, 'win32')), false);
});

test('Windows: a locked alp.old.exe (an alpd not restarted) is moved aside and swept on the next start', () => {
  const target = 'C:\\bin\\alp.exe', staged = 'C:\\bin\\.alp.update.3.exe', old = oldPath(target, 'win32');
  const fs = memoryFs(new Map([[target, 'v2'], [staged, 'v3'], [old, 'v1']]), { locked: new Set([old]) });
  replaceExecutable(staged, target, { platform: 'win32', fs, unique: () => 'ab12' });
  assert.equal(fs.files.get(target), 'v3');
  assert.equal(fs.files.get(old), 'v2');
  assert.equal(fs.files.get('C:\\bin\\alp.old.ab12.exe'), 'v1');
  fs.files.set('C:\\bin\\alp.other.exe', 'keep');
  assert.equal(cleanupOldExecutable(target, { platform: 'win32', fs: memoryFs(fs.files) }), true);
  assert.deepEqual([...fs.files.keys()].sort(), ['C:\\bin\\alp.exe', 'C:\\bin\\alp.other.exe']);
  // Locked and not even movable: a clear error before anything moved.
  const stuck = memoryFs(new Map([[target, 'v2'], [staged, 'v3'], [old, 'v1']]), { locked: new Set([old]), failRename: 'locked' });
  assert.throws(() => replaceExecutable(staged, target, { platform: 'win32', fs: stuck, sleep: () => {} }), /alp\.old\.exe is in use.*alp daemon stop/);
  assert.equal(stuck.files.get(target), 'v2');
});

test('Windows: a failed rollback says how to recover', () => {
  const target = 'C:\\bin\\alp.exe', staged = 'C:\\bin\\.alp.update.4.exe';
  const fs = memoryFs(new Map([[target, 'v1'], [staged, 'v2']]), { failRename: from => from === staged || from === oldPath(target, 'win32') });
  assert.throws(() => replaceExecutable(staged, target, { platform: 'win32', fs, sleep: () => {} }), /rename C:\\bin\\alp\.old\.exe to C:\\bin\\alp\.exe yourself/);
});

test('Windows: a briefly busy staged file (a virus scan after its --version run) is retried, a lasting one is not hidden', () => {
  const target = 'C:\\bin\\alp.exe', staged = 'C:\\bin\\.alp.update.5.exe';
  let busy = 3;
  const sleeps = [];
  const fs = memoryFs(new Map([[target, 'v1'], [staged, 'v2']]), { failRename: from => from === staged && busy-- > 0 });
  replaceExecutable(staged, target, { platform: 'win32', fs, sleep: ms => sleeps.push(ms) });
  assert.equal(fs.files.get(target), 'v2');
  assert.deepEqual(sleeps, [50, 100, 150]);
  let calls = 0;
  assert.throws(() => retryBusy(() => { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }, () => {}, 4), /EBUSY/);
  assert.equal(calls, 4);
  calls = 0;
  assert.throws(() => retryBusy(() => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, () => {}), /ENOENT/);
  assert.equal(calls, 1, 'only busy errors are retried');
});

test('Unix: one rename over the running file', () => {
  const fs = memoryFs(new Map([['/b/alp', 'v1'], ['/b/.s', 'v2']]));
  replaceExecutable('/b/.s', '/b/alp', { platform: 'linux', fs });
  assert.deepEqual(fs.calls, [['rename', '/b/.s', '/b/alp']]);
});

test('npm mode prints how to update with npm and exits 0; template arguments get a hint', async () => {
  for (const args of [[], ['--check'], ['--yes']]) {
    const out = [];
    assert.equal(await selfUpdate(args, { packaged: false, log: l => out.push(l), warn: l => out.push(l) }), 0);
    assert.match(out.join('\n'), /npm install -g @anhlp\/alp@beta/);
    assert.doesNotMatch(out.join('\n'), /did you mean/);
  }
  const out = [];
  assert.equal(await selfUpdate(['/some/project'], { packaged: false, log: l => out.push(l), warn: l => out.push(l) }), 0);
  assert.match(out.join('\n'), /did you mean `alp update-template`\?/);
  assert.match(npmMessage(['.']), /did you mean `alp update-template`/);
  const unknown = [];
  assert.equal(await selfUpdate(['--force'], { packaged: false, log: l => unknown.push(l), warn: l => unknown.push(l) }), 0);
  assert.match(unknown.join('\n'), /did you mean `alp update-template`/);
  const packaged = [];
  assert.equal(await selfUpdate(['.'], { packaged: true, log: l => packaged.push(l), warn: l => packaged.push(l) }), 1);
  assert.match(packaged.join('\n'), /did you mean `alp update-template`/);
});

/** A file:// mirror with one real archive for this host holding a fake executable. */
async function mirror(t, { version = '9.9.9', corrupt = false } = {}) {
  const work = await mkdtemp(path.join(tmpdir(), 'alp-self-update-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const platform = releasePlatform();
  const windows = process.platform === 'win32';
  const name = `alp-${version}-${platform}`;
  await mkdir(path.join(work, 'src', name), { recursive: true });
  await writeFile(path.join(work, 'src', name, windows ? 'alp.exe' : 'alp'), `new ${version}`);
  const mirrorDir = path.join(work, 'mirror');
  await mkdir(mirrorDir);
  const archive = path.join(mirrorDir, `${name}${windows ? '.zip' : '.tar.gz'}`);
  const tar = spawnSync('tar', windows ? ['--format', 'zip', '-cf', archive, '-C', path.join(work, 'src'), name] : ['-czf', archive, '-C', path.join(work, 'src'), name]);
  assert.equal(tar.status, 0, String(tar.stderr));
  const digest = corrupt ? H('0') : sha256(await readFile(archive));
  await writeFile(path.join(mirrorDir, 'SHA256SUMS'), `${digest}  ${path.basename(archive)}\n`);
  const bin = path.join(work, 'bin');
  await mkdir(bin);
  const exe = path.join(bin, windows ? 'alp.exe' : 'alp');
  await writeFile(exe, 'old');
  await chmod(exe, 0o755);
  return { work, mirrorDir, exe, version };
}

const baseDeps = (m, out) => ({
  packaged: true, version: '1.0.0', execPath: m.exe, env: { ALP_UPDATE_BASE_URL: pathToFileURL(m.mirrorDir).href },
  log: l => out.push(l), warn: l => out.push(l), interactive: false, provenance: () => 'unavailable',
  runVersion: file => (spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8").replace(/^new /, ""))', file], { encoding: 'utf8' }).stdout),
});

test('packaged: --check reports only; --yes replaces the executable from a file:// mirror and warns without gh', async t => {
  const m = await mirror(t);
  const out = [];
  assert.equal(await selfUpdate(['--check'], baseDeps(m, out)), 0);
  assert.match(out.join('\n'), /1\.0\.0 → 9\.9\.9 available/);
  assert.equal(await readFile(m.exe, 'utf8'), 'old');
  await assert.rejects(selfUpdate([], baseDeps(m, [])), /pass --yes/);
  const out2 = [];
  assert.equal(await selfUpdate(['--yes'], { ...baseDeps(m, out2), daemon: async () => ({ version: '1.0.0', sessions: 2 }), restartDaemon: () => assert.fail('never restarts on its own') }), 0);
  assert.equal(await readFile(m.exe, 'utf8'), 'new 9.9.9');
  const text = out2.join('\n');
  assert.match(text, /only the SHA256SUMS checksum was verified/);
  assert.match(text, /alpd 1\.0\.0 is still running with 2 live sessions; .*alp daemon restart/);
  const unknown = [];
  assert.equal(await selfUpdate(['--version', '9.9.9'], { ...baseDeps(m, unknown), interactive: true, daemon: async () => ({ version: '1.0.0' }), confirm: async q => /^Replace/.test(q) || assert.fail('no restart offer when the sessions are unknown') }), 0);
  assert.match(unknown.join('\n'), /its live sessions could not be read/);
  const older = [];
  assert.equal(await selfUpdate(['--check'], { ...baseDeps(m, older), version: '10.0.0' }), 0);
  assert.match(older.join('\n'), /10\.0\.0 is newer than the latest release 9\.9\.9/);
  const out3 = [];
  assert.equal(await selfUpdate(['--yes'], { ...baseDeps(m, out3), version: '9.9.9' }), 0);
  assert.match(out3.join('\n'), /up to date/);
});

test('packaged: a checksum mismatch replaces nothing', async t => {
  const m = await mirror(t, { corrupt: true });
  await assert.rejects(selfUpdate(['--yes'], baseDeps(m, [])), /Checksum mismatch/);
  assert.equal(await readFile(m.exe, 'utf8'), 'old');
  const leftovers = (await import('node:fs')).readdirSync(path.dirname(m.exe));
  assert.deepEqual(leftovers, [path.basename(m.exe)]);
});

test('packaged: a failed provenance check or a wrong reported version replaces nothing', async t => {
  const m = await mirror(t);
  await assert.rejects(selfUpdate(['--yes'], { ...baseDeps(m, []), provenance: () => { throw new Error('gh attestation verify refused'); } }), /refused/);
  assert.equal(await readFile(m.exe, 'utf8'), 'old');
  await assert.rejects(selfUpdate(['--yes'], { ...baseDeps(m, []), runVersion: () => '6.6.6' }), /reports version "6.6.6", not 9.9.9/);
  assert.equal(await readFile(m.exe, 'utf8'), 'old');
  assert.ok(existsSync(m.exe));
});

test('the CLI routes update-template to the template upgrade and update to the self-update', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const usage = spawnSync(process.execPath, ['--conditions=alp-source', cli], { encoding: 'utf8', env: { ...process.env, ALP_HOME: path.join(tmpdir(), 'alp-none') } });
  assert.match(usage.stderr, /alp <init\|update-template> \[directory\]/);
  assert.match(usage.stderr, /alp update \[--check\] \[--yes\] \[--version X\]/);
  const npm = spawnSync(process.execPath, ['--conditions=alp-source', cli, 'update', '.'], { encoding: 'utf8', env: { ...process.env, ALP_HOME: path.join(tmpdir(), 'alp-none') } });
  assert.equal(npm.status, 0, npm.stderr);
  assert.match(npm.stdout, /did you mean `alp update-template`/);
  assert.match(npm.stdout, /npm install -g @anhlp\/alp@beta/);
});
