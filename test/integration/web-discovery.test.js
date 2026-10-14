import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..', '..');
const clientDist = path.join(root, 'packages', 'client', 'dist', 'index.js');
const execFileAsync = promisify(execFile);

/**
 * How the CLI stays useful as a `npm install -g` distribution: the globally linked bin is a symlink
 * into the package, and discovery must find the descriptor the distribution ships beside it and use
 * the home the caller selected, not the ambient `ALP_HOME`. Both are exercised through a real child
 * process, so `process.argv[1]` is the symlink the way it is on a user's machine.
 */
async function makeDistribution() {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-distribution-'));
  const distro = path.join(directory, 'distro');
  const bin = path.join(directory, 'node_modules', '.bin');
  await mkdir(path.join(distro, 'integrations'), { recursive: true });
  await mkdir(path.join(distro, 'packages', 'cli', 'dist'), { recursive: true });
  await mkdir(bin, { recursive: true });
  // The distribution is an ESM package, as the real one is.
  await writeFile(path.join(distro, 'package.json'), JSON.stringify({ name: '@anhlp/alp', type: 'module', version: '0.0.0-test' }));
  // The descriptor points at a bundled entry, relative to its own directory.
  await writeFile(path.join(distro, 'integrations', 'web.json'), JSON.stringify({ main: './entry.js' }));
  await writeFile(path.join(distro, 'integrations', 'entry.js'), await entrySource());
  // The CLI the global bin links to: a probe that reports what discovery and startIntegration find.
  await writeFile(path.join(distro, 'packages', 'cli', 'dist', 'cli.js'), await probeSource());
  await symlink(path.join(distro, 'packages', 'cli', 'dist', 'cli.js'), path.join(bin, 'alp'));
  return { directory, distro, bin, cli: path.join(bin, 'alp') };
}

/** The bundled integration entry: publish the ready lock and web.json in the home it is given. */
async function entrySource() {
  return `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const home = process.env.ALP_HOME;
if (!home) { console.error('no ALP_HOME'); process.exit(1); }
await mkdir(path.join(home, 'integrations'), { recursive: true });
await writeFile(path.join(home, 'integrations', 'argv.json'), JSON.stringify(process.argv.slice(2)));
// The detached launcher cannot read our console, so a service entry writes its advertised log itself.
if (process.argv.includes('--service')) {
  await mkdir(path.join(home, 'logs', 'integrations'), { recursive: true });
  await writeFile(path.join(home, 'logs', 'integrations', 'paseo.log'), 'integration started\\n');
}
await writeFile(path.join(home, 'web.json'), JSON.stringify({ pid: process.pid, port: 0, token: 't'.repeat(64), serverId: 'alp-test', url: 'http://127.0.0.1:0/' }));
await writeFile(path.join(home, 'integrations', 'web.lock'), JSON.stringify({ pid: process.pid, ready: true, socket: path.join(home, 'alp.sock') }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 60_000);
`;
}

/** The globally linked CLI: reports discovery and startIntegration results as JSON on stdout. */
async function probeSource() {
  return `import { discoverIntegration, startIntegration } from ${JSON.stringify(new URL(`file://${clientDist}`).href)};
const [mode, home] = process.argv.slice(2);
if (mode === 'discover') {
  const found = await discoverIntegration('web', { home });
  console.log(JSON.stringify({ argv1: process.argv[1], found: found ?? null }));
} else {
  const lock = await startIntegration({ name: 'web', home });
  console.log(JSON.stringify({ argv1: process.argv[1], lock }));
}
`;
}

async function probe({ cli, cwd, home, ambientHome, mode }) {
  const { stdout } = await execFileAsync(process.execPath, [cli, mode, home], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, ALP_HOME: ambientHome ?? home, ALP_WEB_INTEGRATION: '', ALP_INTEGRATION_ENTRY: '' },
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

test('a globally symlinked CLI finds the descriptor its own distribution ships', async t => {
  const { directory, distro, cli } = await makeDistribution();
  const home = path.join(directory, 'home');
  await mkdir(home, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Run from a neutral directory with a home that registers nothing, so only the distribution's own
  // descriptor can satisfy discovery.
  const result = await probe({ cli, cwd: directory, home, mode: 'discover' });
  assert.equal(await realpath(cli), await realpath(path.join(distro, 'packages', 'cli', 'dist', 'cli.js')), 'the bin is a symlink into the distribution');
  assert.equal(result.argv1, cli, 'the child ran through the symlink, not its target');
  assert.equal(result.found, path.join(await realpath(directory), 'distro', 'integrations', 'entry.js'), 'the symlinked CLI resolved its own bundled descriptor');
});

test('startIntegration keeps every artifact in the selected home and passes it to the child', async t => {
  const { directory, cli } = await makeDistribution();
  const selected = path.join(directory, 'selected-home');
  const ambient = path.join(directory, 'ambient-home');
  await mkdir(selected, { recursive: true });
  await mkdir(ambient, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const { lock } = await probe({ cli, cwd: directory, home: selected, ambientHome: ambient, mode: 'start' });
  const pid = lock?.pid;
  assert.ok(Number.isSafeInteger(pid), 'a real integration process was started');
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch {} });

  // The lock and web.json are in the selected home, never the ambient one.
  const web = JSON.parse(await readFile(path.join(selected, 'web.json'), 'utf8'));
  assert.equal(web.pid, pid, 'the selected home holds the integration metadata');
  assert.ok(existsSync(path.join(selected, 'integrations', 'web.lock')), 'the ready lock is in the selected home');
  assert.ok(!existsSync(path.join(ambient, 'web.json')), 'the ambient home is untouched');
  assert.ok(!existsSync(path.join(ambient, 'integrations')), 'the ambient home got no integrations directory');

  // The launcher starts the entry as a detached service, so the entry can write the log its errors
  // advertise. Without this the normal `alp web` path loses every startup error.
  const argv = JSON.parse(await readFile(path.join(selected, 'integrations', 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--service'), `the detached entry must be told it is a service, got ${JSON.stringify(argv)}`);
  assert.equal(await readFile(path.join(selected, 'logs', 'integrations', 'paseo.log'), 'utf8'), 'integration started\n', 'the advertised integration log is created at the documented path');

  // Give the child a moment to fall over if the ALP_HOME it received were wrong; it must stay alive.
  await sleep(200);
  process.kill(pid, 0);
});
