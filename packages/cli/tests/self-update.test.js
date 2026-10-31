import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  allowedHop, bundleCommand, retryBusy, compareVersions, fetchBytes, npmMessage, pruneVersions, releaseBaseUrl, releasePlatform,
  selectAsset, selfUpdate, sha256, switchCurrent, verifyChecksum, verifyProvenance,
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
  assert.throws(() => releasePlatform('win32', 'arm64'), /no build/);
  assert.throws(() => releasePlatform('freebsd', 'x64'), /no build/);
  assert.deepEqual(selectAsset(SUMS, 'linux-x64'), { sha256: H('c'), name: 'alp-1.2.0-linux-x64.tar.gz', version: '1.2.0' });
  assert.deepEqual(selectAsset(SUMS, 'windows-x64'), { sha256: H('e'), name: 'alp-1.2.0-windows-x64.zip', version: '1.2.0' });
  assert.equal(selectAsset(SUMS, 'darwin-arm64', '1.2.0').sha256, H('a'));
  assert.throws(() => selectAsset(SUMS, 'darwin-arm64', '1.3.0'), /no ALP build for darwin-arm64 at version 1.3.0/);
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

test('a briefly busy file (a virus scan after its --version run) is retried, a lasting one is not hidden', () => {
  let calls = 0;
  const sleeps = [];
  assert.throws(() => retryBusy(() => { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }, ms => sleeps.push(ms), 4), /EBUSY/);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [50, 100, 150]);
  calls = 0;
  assert.throws(() => retryBusy(() => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, () => {}), /ENOENT/);
  assert.equal(calls, 1, 'only busy errors are retried');
});

test('outside the ALP bundle (npm) it prints how to update with npm and exits 0; template arguments get a hint', async () => {
  for (const args of [[], ['--check'], ['--yes']]) {
    const out = [];
    assert.equal(await selfUpdate(args, { bundle: undefined, log: l => out.push(l), warn: l => out.push(l) }), 0);
    assert.match(out.join('\n'), /npm install -g @anhlp\/alp@beta/);
    assert.doesNotMatch(out.join('\n'), /did you mean/);
  }
  const out = [];
  assert.equal(await selfUpdate(['/some/project'], { bundle: undefined, log: l => out.push(l), warn: l => out.push(l) }), 0);
  assert.match(out.join('\n'), /did you mean `alp update-template`\?/);
  assert.match(npmMessage(['.']), /did you mean `alp update-template`/);
  const unknown = [];
  assert.equal(await selfUpdate(['--force'], { bundle: undefined, log: l => unknown.push(l), warn: l => unknown.push(l) }), 0);
  assert.match(unknown.join('\n'), /did you mean `alp update-template`/);
  const bundled = [];
  assert.equal(await selfUpdate(['.'], { bundle: { root: '/a/app/1.0.0', app: '/a/app', version: '1.0.0', platform: 'x', current: '/a/app/current' }, log: l => bundled.push(l), warn: l => bundled.push(l) }), 1);
  assert.match(bundled.join('\n'), /did you mean `alp update-template`/);
});

test('a bundle that install.sh did not install (no app/current) is not updated in place', async () => {
  const out = [];
  assert.equal(await selfUpdate(['--yes'], { bundle: { root: '/tmp/alp-1.0.0-x', app: '/tmp', version: '1.0.0', platform: 'x' }, fetchBytes: async () => assert.fail('no download'), log: l => out.push(l), warn: l => out.push(l) }), 1);
  assert.match(out.join('\n'), /not an installed ALP.*install\.sh/s);
});

/** An installed bundle (<app>/1.0.0, current → it) and a file:// mirror with one archive for this host. */
async function mirror(t, { version = '9.9.9', corrupt = false, bundleVersion = version } = {}) {
  const work = await mkdtemp(path.join(tmpdir(), 'alp-self-update-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const platform = releasePlatform();
  const windows = process.platform === 'win32';
  const name = `alp-${version}-${platform}`;
  await mkdir(path.join(work, 'src', name), { recursive: true });
  await writeFile(path.join(work, 'src', name, 'alp-bundle.json'), JSON.stringify({ name: 'alp', version: bundleVersion, platform }));
  const mirrorDir = path.join(work, 'mirror');
  await mkdir(mirrorDir);
  const archive = path.join(mirrorDir, `${name}${windows ? '.zip' : '.tar.gz'}`);
  const tar = spawnSync('tar', windows ? ['--format', 'zip', '-cf', archive, '-C', path.join(work, 'src'), name] : ['-czf', archive, '-C', path.join(work, 'src'), name]);
  assert.equal(tar.status, 0, String(tar.stderr));
  const digest = corrupt ? H('0') : sha256(await readFile(archive));
  await writeFile(path.join(mirrorDir, 'SHA256SUMS'), `${digest}  ${path.basename(archive)}\n`);
  const app = await realpath(await mkdir(path.join(work, 'app'), { recursive: true }).then(() => path.join(work, 'app')));
  const root = path.join(app, '1.0.0');
  await mkdir(root);
  await writeFile(path.join(root, 'alp-bundle.json'), JSON.stringify({ name: 'alp', version: '1.0.0', platform }));
  await mkdir(path.join(app, '0.9.0'));
  await mkdir(path.join(app, '.alp-update-0123ab'));
  switchCurrent(app, '1.0.0');
  return { work, mirrorDir, app, root, version, bundle: { root, app, version: '1.0.0', platform, current: path.join(app, 'current') } };
}

const currentVersion = async m => JSON.parse(await readFile(path.join(m.app, 'current', 'alp-bundle.json'), 'utf8')).version;

const baseDeps = (m, out) => ({
  bundle: m.bundle, version: '1.0.0', env: { ALP_UPDATE_BASE_URL: pathToFileURL(m.mirrorDir).href },
  log: l => out.push(l), warn: l => out.push(l), interactive: false, provenance: () => 'unavailable',
  runVersion: root => JSON.parse(readFileSync(path.join(root, 'alp-bundle.json'), 'utf8')).version,
});

test('bundle: --check reports only; --yes installs app/<version> from a file:// mirror, switches current and prunes', async t => {
  const m = await mirror(t);
  const out = [];
  assert.equal(await selfUpdate(['--check'], baseDeps(m, out)), 0);
  assert.match(out.join('\n'), /1\.0\.0 → 9\.9\.9 available/);
  assert.equal(await currentVersion(m), '1.0.0');
  await assert.rejects(selfUpdate([], baseDeps(m, [])), /pass --yes/);
  const out2 = [];
  assert.equal(await selfUpdate(['--yes'], { ...baseDeps(m, out2), daemon: async () => ({ version: '1.0.0', sessions: 2 }), restartDaemon: () => assert.fail('never restarts on its own') }), 0);
  assert.equal(await currentVersion(m), '9.9.9');
  // The running version stays (this process and alpd still use it); older versions and staging go.
  assert.deepEqual(readdirSync(m.app).sort(), ['1.0.0', '9.9.9', 'current']);
  if (process.platform !== 'win32') assert.equal(readlinkSync(path.join(m.app, 'current')), '9.9.9', 'a relative link: the app directory can move');
  const text = out2.join('\n');
  assert.match(text, /only the SHA256SUMS checksum was verified/);
  assert.match(text, /alpd 1\.0\.0 is still running with 2 live sessions; .*alp daemon restart/);
  const older = [];
  assert.equal(await selfUpdate(['--check'], { ...baseDeps(m, older), version: '10.0.0' }), 0);
  assert.match(older.join('\n'), /10\.0\.0 is newer than the latest release 9\.9\.9/);
  const out3 = [];
  assert.equal(await selfUpdate(['--yes'], { ...baseDeps(m, out3), version: '9.9.9' }), 0);
  assert.match(out3.join('\n'), /up to date/);
});

test('bundle: --version of the running version reinstalls it and keeps the running copy aside', async t => {
  const m = await mirror(t, { version: '1.0.0' });
  const unknown = [];
  assert.equal(await selfUpdate(['--version', '1.0.0'], { ...baseDeps(m, unknown), interactive: true, daemon: async () => ({ version: '0.9.0' }), confirm: async q => /^Install/.test(q) || assert.fail('no restart offer when the sessions are unknown') }), 0);
  assert.match(unknown.join('\n'), /its live sessions could not be read/);
  const names = readdirSync(m.app).sort();
  assert.ok(names.includes('1.0.0') && names.includes('current') && names.some(name => /^\.alp-old-[0-9a-f]+$/.test(name)), names.join(','));
});

test('bundle: a reinstall whose final move fails puts the running copy back (t-1f14)', async t => {
  const m = await mirror(t, { version: '1.0.0' });
  // The unpacked copy disappears after its version check, so moving it into place fails.
  const runVersion = root => { const version = JSON.parse(readFileSync(path.join(root, 'alp-bundle.json'), 'utf8')).version; rmSync(root, { recursive: true, force: true }); return version; };
  await assert.rejects(selfUpdate(['--version', '1.0.0', '--yes'], { ...baseDeps(m, []), runVersion }), /ENOENT/);
  assert.equal(await currentVersion(m), '1.0.0');
  assert.ok(!readdirSync(m.app).some(name => name.startsWith('.alp-old-')), readdirSync(m.app).join(','));
  assert.ok(existsSync(path.join(m.app, '1.0.0', 'alp-bundle.json')), 'the running copy is back in app/1.0.0');
});

test('bundle: a checksum mismatch, a failed provenance check or a wrong version changes nothing', async t => {
  for (const [options, deps, error] of [
    [{ corrupt: true }, {}, /Checksum mismatch/],
    [{}, { provenance: () => { throw new Error('gh attestation verify refused'); } }, /refused/],
    [{}, { runVersion: () => '6.6.6' }, /reports version "6.6.6", not 9.9.9/],
    [{ bundleVersion: '9.9.8' }, {}, /holds ALP 9\.9\.8/],
  ]) {
    const m = await mirror(t, options);
    const before = readdirSync(m.app).sort();
    await assert.rejects(selfUpdate(['--yes'], { ...baseDeps(m, []), ...deps }), error);
    assert.equal(await currentVersion(m), '1.0.0');
    assert.deepEqual(readdirSync(m.app).sort(), before, 'no staging left behind, nothing pruned');
  }
});

test('switchCurrent on Windows replaces the junction and puts the old one back on failure', () => {
  const links = new Map([['C:\\a\\current', 'C:\\a\\1.0.0']]);
  const calls = [];
  const fs = {
    readlinkSync: file => { if (!links.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return links.get(file); },
    unlinkSync: file => { calls.push(['unlink', file]); links.delete(file); },
    symlinkSync: (target, file, type) => { calls.push(['link', target, file, type]); if (target.endsWith('bad')) throw new Error('EPERM'); links.set(file, target); },
  };
  switchCurrent('C:\\a', '2.0.0', { platform: 'win32', fs });
  assert.equal(links.get('C:\\a\\current'), 'C:\\a\\2.0.0');
  assert.throws(() => switchCurrent('C:\\a', 'bad', { platform: 'win32', fs }), /EPERM/);
  assert.equal(links.get('C:\\a\\current'), 'C:\\a\\2.0.0', 'the previous junction is back');
});

test('pruneVersions removes only other versions and staging directories', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'alp-prune-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  for (const name of ['1.0.0', '2.0.0', '3.0.0', '.alp-update-ab', '.alp-old-cd', 'notes', 'current']) await mkdir(path.join(app, name));
  assert.deepEqual(pruneVersions(app, ['3.0.0', '2.0.0']).sort(), ['.alp-old-cd', '.alp-update-ab', '1.0.0']);
  assert.deepEqual(readdirSync(app).sort(), ['2.0.0', '3.0.0', 'current', 'notes']);
});

test('bundleCommand runs the bundle\'s own Node and CLI', () => {
  assert.deepEqual(bundleCommand('/a/app/1.0.0', 'linux'), { command: path.join('/a/app/1.0.0', 'node', 'bin', 'node'), args: [path.join('/a/app/1.0.0', 'lib', 'node_modules', '@anhlp', 'alp-cli', 'dist', 'cli.js')] });
  assert.equal(bundleCommand('C:\\a', 'win32').command, path.join('C:\\a', 'node', 'node.exe'));
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

test('pruneVersions keeps listed versions, and with keepAside the copies a running alpd may use', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'alp-prune-aside-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  for (const name of ['1.0.0', '2.0.0', '3.0.0', '.alp-old-ab', '.alp-update-cd']) await mkdir(path.join(app, name));
  assert.deepEqual(pruneVersions(app, ['3.0.0', '1.0.0'], undefined, { keepAside: true }).sort(), ['.alp-update-cd', '2.0.0']);
  assert.deepEqual(readdirSync(app).sort(), ['.alp-old-ab', '1.0.0', '3.0.0']);
});
