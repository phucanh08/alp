// Release artifacts (docs/alp/beta-scope.md §6–7, scripts/release-*.mjs): the source check, the
// manifest and SHA256SUMS of a saved release, A5 on the saved files, the consumer lockfile check and
// the gate. Fixture tarballs are written here, so nothing packs, builds or touches a registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  GATE_PHASES, GATE_ROWS, MANIFEST_FILE, RELEASE_NAMES, RELEASE_PACKAGES, SUMS_FILE, createReleaseManifest, digests, evaluateGate,
  formatSha256Sums, gateTemplate, installedProblems, parseSha256Sums, readTarball, releaseArtifacts, shippedWebProblems, SHIPPED_WEB_FILES, sourceProblems, tarballFilename, verifyRelease,
} from '../../scripts/release-lib.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
// Synthetic semver: unrelated to any current or published release.
const VERSION = '42.17.9-fixture.314';
const SHA = 'a'.repeat(40);
const LICENSE = 'Apache License\nVersion 2.0\n';
const NOTICE = 'ALP\nCopyright 2026\n';

/** A gzipped ustar archive under `package/`, as npm writes it; long names use the prefix field or a pax header. */
function tarball(files, { pax = false } = {}) {
  const blocks = [];
  const header = (name, size, type, prefix = '') => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100);
    block.write('0000644\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    block.write(prefix, 345, 155);
    block.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
  };
  const pad = body => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const full = `package/${name}`;
    if (full.length > 100 && pax) {
      const record = ` path=${full}\n`;
      let length = record.length + 2;
      while (`${length}${record}`.length !== length) length += 1;
      const paxBody = Buffer.from(`${length}${record}`);
      blocks.push(header('PaxHeader', paxBody.length, 'x'), pad(paxBody), header(full.slice(0, 99), body.length, '0'));
    } else if (full.length > 100) {
      const cut = full.indexOf('/', full.length - 101);
      blocks.push(header(full.slice(cut + 1), body.length, '0', full.slice(0, cut)));
    } else blocks.push(header(full, body.length, '0'));
    blocks.push(pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** The files of one fixture package, valid for A5 unless `change` says otherwise. */
function packageFiles(name, version = VERSION) {
  const internal = RELEASE_NAMES.indexOf(name) > 0 ? { '@anhlp/alp-protocol': version } : {};
  const pkg = { name, version, license: 'Apache-2.0', dependencies: { ...internal, ws: '^8.0.0' } };
  const files = { 'package.json': JSON.stringify(pkg), LICENSE, NOTICE, 'dist/index.js': 'export {};\n' };
  if (name === '@anhlp/alp-paseo') Object.assign(files, {
    NOTICE: `${NOTICE}\nThis product includes Paseo.\n`,
    'LICENSE.paseo.txt': 'Paseo licence\n',
  });
  return files;
}

/** A saved release directory as release-pack writes it; `change(name, files)` edits a package's files first. */
function writeRelease(directory, { change, git = { sha: SHA, tag: `v${VERSION}`, dirty: false }, pack = { ignoreScripts: false, rehearsal: false } } = {}) {
  const artifacts = RELEASE_PACKAGES.map(({ name }) => {
    const files = packageFiles(name);
    change?.(name, files);
    const buffer = tarball(files);
    const filename = tarballFilename(name, VERSION);
    writeFileSync(path.join(directory, filename), buffer);
    return { name, version: VERSION, filename, entryCount: Object.keys(files).length, ...digests(buffer) };
  });
  const sums = formatSha256Sums(artifacts);
  writeFileSync(path.join(directory, SUMS_FILE), sums);
  const manifest = createReleaseManifest({ version: VERSION, git, build: { node: process.version }, pack, artifacts, sha256sums: digests(Buffer.from(sums)).sha256 });
  writeFileSync(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function fixtureEnv(directory) {
  return { PATH: process.env.PATH, HOME: directory, ALP_HOME: path.join(directory, 'home') };
}

function withRelease(options, check) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alp-release-test-'));
  try { return check(directory, writeRelease(directory, options)); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('digests are npm\'s integrity and shasum plus the SHA-256 that SHA256SUMS lists', () => {
  const abc = digests(Buffer.from('abc'));
  assert.equal(abc.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(abc.shasum, 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(abc.integrity, 'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==');
  assert.equal(abc.size, 3);
  assert.equal(tarballFilename('@anhlp/alp-core', VERSION), 'anhlp-alp-core-42.17.9-fixture.314.tgz');
  assert.equal(tarballFilename('@anhlp/alp', VERSION), 'anhlp-alp-42.17.9-fixture.314.tgz');
});

test('SHA256SUMS is written sorted in sha256sum format and read back, binary marker included', () => {
  const text = formatSha256Sums([{ filename: 'b.tgz', sha256: 'b'.repeat(64) }, { filename: 'a.tgz', sha256: 'a'.repeat(64) }]);
  assert.equal(text, `${'a'.repeat(64)}  a.tgz\n${'b'.repeat(64)}  b.tgz\n`);
  assert.deepEqual([...parseSha256Sums(text)], [['a.tgz', 'a'.repeat(64)], ['b.tgz', 'b'.repeat(64)]]);
  assert.deepEqual([...parseSha256Sums(`${'c'.repeat(64)} *c.tgz\r\n`)], [['c.tgz', 'c'.repeat(64)]]);
  assert.throws(() => parseSha256Sums('nope  a.tgz\n'), /unreadable line/);
  assert.throws(() => parseSha256Sums(`${'a'.repeat(64)}  a.tgz\n${'b'.repeat(64)}  a.tgz\n`), /listed twice/);
});

test('tarballs are read under package/, long names through the ustar prefix and pax headers', () => {
  const long = `server/dist/${'very-long-directory-name/'.repeat(5)}module.js`;
  for (const pax of [false, true]) {
    const files = readTarball(tarball({ 'package.json': '{}', [long]: 'x' }, { pax }));
    assert.deepEqual([...files.keys()], ['package.json', long]);
    assert.equal(files.get(long).toString(), 'x');
  }
});

test('the source check wants exactly the eight packages public, one version, pinned dependencies and the lockfile in step', () => {
  const workspaces = RELEASE_PACKAGES.map(({ name, location }) => ({ location, pkg: JSON.parse(packageFiles(name)['package.json']) }));
  workspaces.push({ location: 'apps/gateway', pkg: { name: '@anhlp/alp-gateway', version: VERSION, private: true } });
  const lock = { packages: Object.fromEntries(workspaces.map(({ location, pkg }) => [location === '.' ? '' : location, { version: pkg.version, dependencies: pkg.dependencies }])) };
  assert.deepEqual(sourceProblems({ workspaces, lock, version: VERSION }), []);

  const broken = structuredClone(workspaces);
  broken.at(-1).pkg.private = false;
  broken[2].pkg.dependencies['@anhlp/alp-protocol'] = '^42.17.9-fixture.314';
  broken[3].pkg.version = '0.0.0-beta';
  assert.deepEqual(sourceProblems({ workspaces: broken, lock, version: VERSION }), [
    '@anhlp/alp-gateway is public but not a release package; mark it "private": true',
    '@anhlp/alp-runtime: dependencies @anhlp/alp-protocol@^42.17.9-fixture.314, not pinned to 42.17.9-fixture.314',
    '@anhlp/alp-runtime: package-lock.json dependencies @anhlp/alp-protocol@42.17.9-fixture.314 differs from package.json ^42.17.9-fixture.314; run npm install',
    '@anhlp/alp-client: version 0.0.0-beta, expected 42.17.9-fixture.314',
  ]);
  const staleLock = structuredClone(lock);
  staleLock.packages['packages/core'].version = '0.10.0';
  assert.deepEqual(sourceProblems({ workspaces, lock: staleLock, version: VERSION }), ['@anhlp/alp-core: package-lock.json records 0.10.0, expected 42.17.9-fixture.314']);
  assert.match(sourceProblems({ workspaces, lock, version: 'beta' })[0], /not a semver version/);
});

test('this repository passes the release source check at its own version', () => {
  withRelease({}, directory => {
    const result = spawnSync(process.execPath, ['scripts/release-check.mjs'], { cwd: root, env: fixtureEnv(directory), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test('A5 passes on a saved release and binds it to the release SHA', () => withRelease({}, (directory, manifest) => {
  const result = verifyRelease(directory, { sha: SHA, version: VERSION });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.artifacts.map(artifact => artifact.name), RELEASE_NAMES);
  assert.equal(manifest.sha256sums, digests(readFileSync(path.join(directory, SUMS_FILE))).sha256);
  assert.deepEqual(manifest.packages.map(entry => Object.keys(entry).sort()), RELEASE_NAMES.map(() => ['entryCount', 'filename', 'integrity', 'name', 'sha256', 'shasum', 'size', 'version']));
  assert.match(verifyRelease(directory, { sha: 'b'.repeat(40) }).problems.join('\n'), /not the release SHA b{40}/);
  assert.match(verifyRelease(directory, { version: '42.17.9-fixture.315' }).problems.join('\n'), /version 42\.17\.9-fixture\.314, expected 42\.17\.9-fixture\.315/);
}));

test('a tarball changed after packing fails A5 and is never handed to the consumer checks', () => withRelease({}, directory => {
  const file = path.join(directory, tarballFilename('@anhlp/alp-core', VERSION));
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0])]));
  const result = verifyRelease(directory);
  assert.match(result.checksumProblems.join('\n'), /@anhlp\/alp-core .*SHA-256 [0-9a-f]{64} does not match SHA256SUMS/);
  assert.match(result.checksumProblems.join('\n'), /integrity .* does not match release-manifest\.json/);
  assert.throws(() => releaseArtifacts(directory), /do not match their checksums/);
}));

test('an extra tarball, an edited SHA256SUMS or a missing tarball fails A5', () => withRelease({}, directory => {
  writeFileSync(path.join(directory, tarballFilename('@anhlp/alp-gateway', VERSION)), tarball(packageFiles('@anhlp/alp-gateway')));
  assert.match(verifyRelease(directory).problems.join('\n'), /anhlp-alp-gateway-42\.17\.9-fixture\.314\.tgz: tarball not in release-manifest\.json/);
  rmSync(path.join(directory, tarballFilename('@anhlp/alp-gateway', VERSION)));
  writeFileSync(path.join(directory, SUMS_FILE), `${readFileSync(path.join(directory, SUMS_FILE), 'utf8')}${'d'.repeat(64)}  extra.tgz\n`);
  const edited = verifyRelease(directory).problems.join('\n');
  assert.match(edited, /sha256sums does not match SHA256SUMS/);
  assert.match(edited, /lists extra\.tgz/);
  rmSync(path.join(directory, tarballFilename('@anhlp/alp-cli', VERSION)));
  assert.match(verifyRelease(directory).problems.join('\n'), /@anhlp\/alp-cli .*tarball missing/);
}));

test('A5 reads the packed package.json: version, pinned internal dependencies, licences, no Paseo in core', () => {
  const problems = change => withRelease({ change }, directory => verifyRelease(directory).problems);
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems((name, files) => {
    if (name !== '@anhlp/alp-daemon') return;
    const pkg = JSON.parse(files['package.json']);
    pkg.dependencies['@anhlp/alp-protocol'] = '0.10.0';
    pkg.dependencies['@anhlp/alp-gateway'] = VERSION;
    files['package.json'] = JSON.stringify(pkg);
  }), [
    '@anhlp/alp-daemon: dependencies @anhlp/alp-protocol@0.10.0, not pinned to 42.17.9-fixture.314',
    '@anhlp/alp-daemon: dependencies @anhlp/alp-gateway is not one of the released packages',
  ]);
  assert.deepEqual(problems((name, files) => { if (name === '@anhlp/alp-core') delete files.LICENSE; }), ['@anhlp/alp-core: no LICENSE']);
  assert.deepEqual(problems((name, files) => { if (name === '@anhlp/alp-cli') files.LICENSE = 'MIT\n'; }), ["@anhlp/alp-cli: LICENSE differs from @anhlp/alp's"]);
  assert.deepEqual(problems((name, files) => { if (name === '@anhlp/alp-paseo') delete files['LICENSE.paseo.txt']; }), ['@anhlp/alp-paseo: no LICENSE.paseo.txt']);
  assert.deepEqual(problems((name, files) => { if (name === '@anhlp/alp-paseo') files['server/dist/web-app/index.html'] = '<html>'; }), ["@anhlp/alp-paseo: carries a stale server/dist/web-app (Paseo's removed web app); delete it and pack again"]);
  assert.deepEqual(problems((name, files) => { if (name === '@anhlp/alp-paseo') files.NOTICE = NOTICE; }), ["@anhlp/alp-paseo: NOTICE is not ALP's NOTICE followed by Paseo's attribution"]);
  assert.match(problems((name, files) => { if (name === '@anhlp/alp') files['integrations/paseo/server/dist/main.js'] = 'export {};'; }).join('\n'), /@anhlp\/alp: forbidden core artifact integrations\/paseo\/server\/dist\/main\.js/);
  assert.deepEqual(problems((name, files) => { if (name === '@anhlp/alp-cli') files['dist/cli.js'] = '// node_modules/smol-toml/dist/index.js\nexport {};\n'; }), ['@anhlp/alp-cli: bundles smol-toml but no THIRD-PARTY-NOTICES.txt lists it']);
  assert.deepEqual(problems((name, files) => {
    if (name !== '@anhlp/alp-cli') return;
    files['dist/cli.js'] = '// node_modules/smol-toml/dist/index.js\nexport {};\n';
    files['dist/THIRD-PARTY-NOTICES.txt'] = 'Third-party software\n\nsmol-toml@1.9.0 (BSD-3-Clause)\n';
  }), []);
});

test('a dirty, untagged or script-less pack is a rehearsal, never gate evidence', () => {
  withRelease({ git: { sha: SHA, tag: null, dirty: true }, pack: { ignoreScripts: true, rehearsal: true } }, directory => {
    const strict = verifyRelease(directory).problems;
    assert.deepEqual(strict, [
      'release-manifest.json: packed from a checkout with uncommitted changes',
      'release-manifest.json: no release tag at the packed commit',
      'release-manifest.json: packed with --ignore-scripts (prepack did not run as for publish)',
    ]);
    const rehearsal = verifyRelease(directory, { rehearsal: true });
    assert.deepEqual(rehearsal.problems, []);
    assert.deepEqual(rehearsal.notes, strict);
    assert.equal(releaseArtifacts(directory).length, 8);
    const cli = spawnSync(process.execPath, ['scripts/release-verify.mjs', directory, '--rehearsal', '--sha', SHA, '--record', path.join(directory, 'evidence.json')], { cwd: root, env: fixtureEnv(directory), encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /--record needs --sha <RELEASE_SHA> and a non-rehearsal run/);
  });
});

test('release-verify and release-gate run on a saved release; the gate stays open until every row has evidence', () => withRelease({}, (directory, manifest) => {
  const evidence = path.join(directory, 'evidence.json');
  const run = (...args) => spawnSync(process.execPath, args, { cwd: root, env: fixtureEnv(directory), encoding: 'utf8' });
  const verify = run('scripts/release-verify.mjs', directory, '--sha', SHA, '--record', evidence);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /A5 passed: 8 tarballs of 42\.17\.9-fixture\.314/);
  const recorded = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.equal(recorded.rows.A5.status, 'pass');
  assert.equal(recorded.rows.A5.artifacts, manifest.sha256sums);
  assert.equal(recorded.rows.R1.status, 'pending');
  const gate = run('scripts/release-gate.mjs', directory, evidence);
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /PASS  A5/);
  assert.match(gate.stdout, /OPEN  R1 .*status pending/);
  assert.match(gate.stdout, /info  R3  \(not blocking\)/);
  assert.match(gate.stdout, /Gate "publish" NOT passed: 10 blocking row\(s\) open\./);
  assert.match(run('scripts/release-gate.mjs', directory, '--init', evidence).stderr, /exists; the gate template never overwrites/);

  const file = path.join(directory, tarballFilename('@anhlp/alp-runtime', VERSION));
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('x')]));
  const tampered = run('scripts/release-verify.mjs', directory);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /A5 FAILED[\s\S]*@anhlp\/alp-runtime/);
}));

test('the gate counts a row only for the release SHA, and artifact rows only for the saved SHA256SUMS', () => {
  const manifest = { version: VERSION, git: { sha: SHA }, sha256sums: 'f'.repeat(64) };
  const pass = id => ({ status: 'pass', sha: SHA, artifacts: GATE_ROWS.find(row => row.id === id).binds === 'artifacts' ? manifest.sha256sums : null, evidence: 'https://ci/run/1' });
  const evidence = gateTemplate(manifest);
  assert.equal(evaluateGate(evidence, manifest).passed, false);
  for (const id of GATE_PHASES.publish) evidence.rows[id] = pass(id);
  assert.equal(evaluateGate(evidence, manifest).passed, true);

  evidence.rows.H5 = { status: 'fail' };
  assert.equal(evaluateGate(evidence, manifest).passed, true, 'H5 (alp-web, unreleased app) does not block');
  for (const id of ['R3', 'R4', 'R6']) evidence.rows[id] = { status: 'pending' };
  assert.equal(evaluateGate(evidence, manifest).passed, true, 'D7: the Linux rows are run when possible and do not block');
  evidence.rows.H2 = { ...pass('H2'), sha: 'b'.repeat(40) };
  evidence.rows.R1 = { ...pass('R1'), artifacts: 'e'.repeat(64) };
  evidence.rows.R2 = { ...pass('R2'), evidence: null };
  evidence.rows.R5 = { status: 'pending' };
  const open = evaluateGate(evidence, manifest);
  assert.equal(open.passed, false);
  assert.deepEqual(open.blocking.map(row => [row.id, row.reasons]), [
    ['H2', [`ran on ${'b'.repeat(40)}, not the release SHA ${SHA}`]],
    ['R1', [`used artifacts ${'e'.repeat(64)}, not this release's SHA256SUMS ${'f'.repeat(64)}`]],
    ['R2', ['no evidence (CI link, log or session ids)']],
    ['R5', ['status pending']],
  ]);
  for (const id of ['H2', 'R1', 'R2', 'R5']) evidence.rows[id] = pass(id);

  // D2: `latest` moves only after Q1–Q3; Q4 and Q5 come after it.
  assert.deepEqual(evaluateGate(evidence, manifest, 'latest').blocking.map(row => row.id), ['Q1', 'Q2', 'Q3']);
  for (const id of ['Q1', 'Q2', 'Q3']) evidence.rows[id] = pass(id);
  assert.equal(evaluateGate(evidence, manifest, 'latest').passed, true);
  assert.deepEqual(evaluateGate(evidence, manifest, 'announce').blocking.map(row => row.id), ['Q4', 'Q5']);
  assert.match(evaluateGate({ ...evidence, version: '42.17.9-fixture.315' }, manifest).blocking.at(-1).reasons[0], /evidence is for 42\.17\.9-fixture\.315/);
  assert.throws(() => evaluateGate(evidence, manifest, 'ship'), /unknown gate phase/);
  assert.equal(evaluateGate(evidence, { ...manifest, git: { sha: null } }).passed, false, 'a manifest without a SHA never passes');
});

test('the consumer lockfile must resolve every @anhlp package to the saved tarball with its integrity', () => withRelease({}, (directory, manifest) => {
  const lock = { packages: Object.fromEntries(manifest.packages.map(entry => [`node_modules/${entry.name}`, { version: VERSION, resolved: `file:${path.join(directory, entry.filename)}`, integrity: entry.integrity }])) };
  assert.deepEqual(installedProblems(lock, manifest), []);
  const fromRegistry = structuredClone(lock);
  fromRegistry.packages['node_modules/@anhlp/alp-core'] = { version: VERSION, resolved: 'https://registry.npmjs.org/@anhlp/alp-core/-/alp-core-42.17.9-fixture.314.tgz', integrity: 'sha512-other' };
  fromRegistry.packages['node_modules/@anhlp/alp/node_modules/@anhlp/alp-client'] = { version: '0.10.0' };
  fromRegistry.packages['node_modules/@anhlp/alp-gateway'] = { version: VERSION };
  delete fromRegistry.packages['node_modules/@anhlp/alp-cli'];
  assert.deepEqual(installedProblems(fromRegistry, manifest), [
    `node_modules/@anhlp/alp-core: integrity sha512-other is not the saved tarball's ${manifest.packages[1].integrity}`,
    'node_modules/@anhlp/alp-core: resolved from https://registry.npmjs.org/@anhlp/alp-core/-/alp-core-42.17.9-fixture.314.tgz, not the saved anhlp-alp-core-42.17.9-fixture.314.tgz',
    'node_modules/@anhlp/alp/node_modules/@anhlp/alp-client: installed 0.10.0, expected 42.17.9-fixture.314',
    `node_modules/@anhlp/alp/node_modules/@anhlp/alp-client: integrity undefined is not the saved tarball's ${manifest.packages[3].integrity}`,
    'node_modules/@anhlp/alp/node_modules/@anhlp/alp-client: resolved from undefined, not the saved anhlp-alp-client-42.17.9-fixture.314.tgz',
    'node_modules/@anhlp/alp-gateway: @anhlp/alp-gateway is not part of the release',
    '@anhlp/alp-cli: not installed',
  ]);
}));

test('both packages that carry the CLI must pack alp web: alp-web.js, its app and the notices', () => {
  const cli = ['dist/alp-web.js', 'dist/alp-web/index.html', 'dist/alp-web/THIRD-PARTY-NOTICES.txt', 'dist/THIRD-PARTY-NOTICES.txt'];
  assert.deepEqual(SHIPPED_WEB_FILES['@anhlp/alp-cli'], cli);
  assert.deepEqual(SHIPPED_WEB_FILES['@anhlp/alp'], cli.map(file => `packages/cli/${file}`));
  assert.deepEqual(Object.keys(SHIPPED_WEB_FILES).sort(), ['@anhlp/alp', '@anhlp/alp-cli'], 'the gateway is never a package of its own');
  assert.deepEqual(shippedWebProblems('@anhlp/alp-cli', ['package.json', ...cli, 'dist/alp-web/assets/index.js']), []);
  assert.deepEqual(shippedWebProblems('@anhlp/alp', SHIPPED_WEB_FILES['@anhlp/alp']), []);
  for (const [name, prefix] of [['@anhlp/alp-cli', 'src/web/'], ['@anhlp/alp', 'packages/cli/src/web/']]) {
    const found = shippedWebProblems(name, [...SHIPPED_WEB_FILES[name], `${prefix}main.js`]);
    assert.equal(found.length, 1);
    assert.match(found[0], /bundled-only .* is packed/);
  }
  for (const file of cli) {
    const found = shippedWebProblems('@anhlp/alp-cli', cli.filter(entry => entry !== file));
    assert.equal(found.length, 1);
    assert.match(found[0], new RegExp(`^@anhlp/alp-cli: ${file.replace(/[.]/g, '\\.')} is not packed`));
  }
  assert.equal(shippedWebProblems('@anhlp/alp', cli).length, 4, 'the root package carries them under packages/cli/');
  // Packages without the CLI carry no alp web, and A5 itself is unchanged by this list.
  for (const name of RELEASE_NAMES.filter(name => !(name in SHIPPED_WEB_FILES))) assert.deepEqual(shippedWebProblems(name, []), []);
  withRelease({}, directory => assert.deepEqual(verifyRelease(directory).problems, []));
});
