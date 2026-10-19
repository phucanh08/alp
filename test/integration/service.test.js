import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installedProgram, serviceDefinition, serviceFor } from '../../packages/client/src/service.js';
import { alpHome, daemonPaths, lockAlive, readLock } from '../../packages/client/src/index.js';

/** RegExp.escape, which Node 22 lacks. */
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../packages/cli/dist/alpd.js', import.meta.url));

test('the service keeps alpd up after a crash but not after a clean stop, with the environment alpd needs', async () => {
  const home = '/tmp/a home & co';
  const resolved = path.resolve(home); // the definitions hold it resolved, which on Windows adds a drive
  const env = { PATH: '/opt/bin:/usr/bin', ALP_CODEX_BIN: '/opt/codex', ALP_SERVICE_DIR: '/tmp/agents', UNRELATED: 'x' };
  const mac = serviceFor({ home, env, platform: 'darwin', uid: 501 });
  assert.match(mac.name, /^com\.alp\.alpd\.[0-9a-f]{8}$/, 'a custom ALP_HOME gets its own service');
  assert.equal(serviceFor({ home: path.join(homedir(), '.alp'), env, platform: 'darwin', uid: 501 }).name, 'com.alp.alpd');
  assert.equal(mac.file, path.join('/tmp/agents', `${mac.name}.plist`));
  assert.deepEqual(mac.install.map(([, args]) => args[0]), ['bootout', 'bootstrap']);
  const plist = serviceDefinition(mac, { home, entry: '/opt/alp/dist/alpd.js', execPath: '/opt/node', env });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>Crashed<\/key>\s*<true\/>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(`<key>ALP_HOME</key>\\s*<string>${escape(resolved.replace('&', '&amp;'))}</string>`));
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, /<key>ALP_CODEX_BIN<\/key>/);
  assert.doesNotMatch(plist, /UNRELATED/);

  const linux = serviceFor({ home, env, platform: 'linux' });
  assert.match(linux.name, /^alpd-[0-9a-f]{8}$/);
  const unit = serviceDefinition(linux, { home, entry: '/opt/a "b"/alpd.js', execPath: '/opt/node', env });
  assert.match(unit, /^ExecStart="\/opt\/node" "\/opt\/a \\"b\\"\/alpd\.js" "--service"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, new RegExp(`^Environment="ALP_HOME=${escape(resolved.replaceAll('\\', '\\\\'))}"$`, 'm')); // systemd quoting doubles backslashes
  assert.equal(serviceFor({ home, env, platform: 'win32' }), undefined);

  // What is installed reads back as the program it runs.
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-service-'));
  try {
    for (const [service, text] of [[{ ...mac, file: path.join(directory, 'a.plist') }, plist], [{ ...linux, file: path.join(directory, 'a.service') }, unit]]) {
      assert.equal(await installedProgram(service), undefined);
      await writeFile(service.file, text);
      assert.deepEqual(await installedProgram(service), ['/opt/node', service.kind === 'launchd' ? '/opt/alp/dist/alpd.js' : '/opt/a "b"/alpd.js']);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('alp daemon install runs alpd under its service until uninstall', { timeout: 30_000, skip: process.platform === 'win32' && 'Windows has no service manager here (serviceFor is undefined) and the stand-in manager is an sh script' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-svc-'));
  const home = path.join(directory, 'home');
  const previousHome = process.env.ALP_HOME;
  process.env.ALP_HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = previousHome; });
  assert.equal(alpHome(), home);
  const paths = daemonPaths(home);
  assert.equal(paths.log, path.join(home, 'logs', 'alpd.log'));
  assert.equal(paths.lock, path.join(home, 'alpd.lock'));
  assert.equal(paths.socket, path.join(home, 'alpd.sock'));
  await assert.rejects(access(path.join(home, 'state')));

  // Hold the install-record rename, after lock readiness but before the ready log.
  // This makes the previously intermittent ordering deterministic.
  const gate = net.createServer();
  const gatePath = path.join(directory, 'gate.sock');
  await new Promise((resolve, reject) => { gate.once('error', reject); gate.listen(gatePath, resolve); });
  let gateSocket;
  t.after(() => {
    // Failure cleanup releases startup admission before asking the CLI to stop it.
    if (gateSocket?.writable) gateSocket.end('continue');
    gate.close();
  });
  let release;
  const held = new Promise(resolve => gate.once('connection', socket => {
    gateSocket = socket;
    socket.on('error', () => socket.destroy());
    release = () => socket.write('continue');
    socket.once('close', resolve);
  }));
  const connected = new Promise(resolve => gate.once('connection', resolve));
  const preload = path.join(directory, 'hold-ready.mjs');
  await writeFile(preload, `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
assert.equal(process.env.ALP_HOME, ${JSON.stringify(home)});
assert.equal(process.env.HOME, ${JSON.stringify(directory)});
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to === process.env.ALP_HOME + '/alpd.json') {
    try { await fs.unlink(${JSON.stringify(path.join(directory, 'hold-once'))}); } catch { return rename(from, to); }
    const socket = net.connect(${JSON.stringify(gatePath)});
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('data', resolve); });
    const write = process.stderr.write;
    process.stderr.write = function(chunk, ...args) {
      const result = write.call(this, chunk, ...args);
      if (String(chunk).includes('"event":"ready"')) socket.destroy();
      return result;
    };
  }
  return rename(from, to);
};
syncBuiltinESMExports();
`);

  const calls = path.join(directory, 'calls');
  t.after(async () => {
    // Only the alpd of this test's home.
    const lock = await readLock(home).catch(() => undefined);
    if (lockAlive(lock)) {
      // The gate cleanup above releases startup admission, even on an assertion failure.
      // The CLI waits for this fixture's daemon to stop before removal.
      await promisify(execFile)(process.execPath, [CLI, 'daemon', 'stop'], {
        env: { PATH: process.env.PATH, HOME: directory, ALP_HOME: home,
          ALP_SERVICE_DIR: path.join(directory, 'agents'),
          ALP_LAUNCHCTL: path.join(directory, 'manager'), ALP_SYSTEMCTL: path.join(directory, 'manager') },
      });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // A service manager that starts alpd as launchd or systemd would, and stops it with SIGTERM.
  const manager = path.join(directory, 'manager');
  await writeFile(manager, `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  bootstrap*|kickstart*|*"enable --now"*|*" start "*)
    "${process.execPath}" --import "${preload}" "${ENTRY}" --service < /dev/null >> "$ALP_HOME/logs/alpd.service.log" 2>&1 &
    ;;
  bootout*|*disable*)
    pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$ALP_HOME/alpd.lock" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid"
    ;;
esac
exit 0
`);
  await chmod(manager, 0o755);
  await writeFile(path.join(directory, 'hold-once'), '');
  const env = { PATH: process.env.PATH, HOME: directory, ALP_HOME: home, ALP_SERVICE_DIR: path.join(directory, 'agents'), ALP_LAUNCHCTL: manager, ALP_SYSTEMCTL: manager };
  const alp = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const service = serviceFor({ home, env });
  assert.equal(path.dirname(service.file), env.ALP_SERVICE_DIR);
  for (const key of ['HOME', 'ALP_HOME', 'ALP_SERVICE_DIR', 'ALP_LAUNCHCTL', 'ALP_SYSTEMCTL']) {
    assert.ok((env[key] === directory || env[key].startsWith(directory + path.sep)), key + ' must stay inside the fixture');
  }

  const installed = await promisify(execFile)(process.execPath, [CLI, 'daemon', 'install'], { env });
  assert.match(installed.stdout, /alpd installed as .*\nalpd .* running \(pid \d+\); it starts at login and again after a crash/);
  assert.deepEqual(await installedProgram(service), [process.execPath, ENTRY]);
  const first = await readLock(home);
  assert.ok(lockAlive(first) && first.ready);
  // The CLI's readiness contract is the ready lock, not a later diagnostic log.
  assert.equal(await readFile(paths.log, 'utf8'), '');
  // The daemon has reached the held rename once its gate connection is accepted.
  // Release without polling or relying on scheduler delays.
  await connected;
  release();
  await held;
  assert.match(alp('daemon', 'status'), new RegExp(`managed by (launchd|systemd) as ${service.name.replace(/\./g, '\\.')}`));
  // doctor exits 1 where no runtime is installed (CI); only its service check matters here.
  const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { env }).stdout.toString();
  assert.ok(JSON.parse(doctor).checks.some(check => check.id === 'service' && check.status === 'ok'));

  assert.match(alp('daemon', 'stop'), /alpd stopped; it stays stopped until alp daemon start, a prompt in Paseo, or the next login/);
  // The gate acknowledges the synchronous service-log write before stop.
  // Keep validating the real log after the daemon has completed its lifecycle.
  assert.match(await readFile(paths.log, 'utf8'), /alpd .* ready on /);
  assert.match(alp('daemon', 'start'), /alpd .* running \(pid \d+\)/);
  const second = await readLock(home);
  assert.notEqual(second.pid, first.pid);
  assert.match(await readFile(calls, 'utf8'), /kickstart|--user start/, 'start goes through the service');

  assert.match(alp('daemon', 'uninstall'), /alpd service .* removed and alpd stopped/);
  await assert.rejects(access(service.file));
  assert.equal(lockAlive(await readLock(home)), false);
  assert.match(alp('daemon', 'uninstall'), /not installed as a service/);
});
