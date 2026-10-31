// The win32 terminal owner (src/windows-terminal.ts): node-pty over ConPTY, best-effort, protection 'none'.
// The unit tests drive the real owner wrapper and the real terminal service with a fake node-pty module on
// every platform. The tests marked "ConPTY" spawn a real cmd.exe through the installed node-pty and run
// only on Windows (the windows-daemon CI lane runs them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWindowsPtySpawn, loadNodePty, windowsPtySpawn, windowsShell, windowsTerminalCapability } from '../dist/windows-terminal.js';
import { createTerminalService, readTerminalConfig } from '../dist/terminals.js';

const windows = process.platform === 'win32';
const conpty = !windows && 'ConPTY exists only on Windows';
const owner = { id: 'owner', epoch: 'e1' };
const quiet = { info() {}, warn() {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
}
async function home(t, config = { version: 1, allowRemoteTerminal: true }) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-win-term-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (config) await writeFile(path.join(dir, 'terminal.json'), JSON.stringify(config), { mode: 0o600 });
  return dir;
}

/** A node-pty module double that records what the owner asks of it. */
function fakeNodePty({ spawnError } = {}) {
  const calls = { spawn: [], write: [], resize: [], kill: [] };
  let data; let exit;
  const fake = {
    calls, resizeThrows: false, killThrows: false,
    emit(text) { data?.(text); },
    exit(event) { exit?.(event); },
    spawn(file, args, options) {
      calls.spawn.push({ file, args, options });
      if (spawnError) throw spawnError;
      return {
        pid: 4242 + calls.spawn.length,
        write(text) { calls.write.push(text); },
        resize(cols, rows) { calls.resize.push([cols, rows]); if (fake.resizeThrows) throw new Error('Cannot resize a pty that has already exited'); },
        kill(...signal) { calls.kill.push(signal); if (fake.killThrows) throw new Error('already exited'); },
        onData(listener) { data = listener; return { dispose() { data = undefined; } }; },
        onExit(listener) { exit = listener; return { dispose() { exit = undefined; } }; },
      };
    },
  };
  return fake;
}
const spawnOptions = (extra = {}) => ({ name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: { TERM: 'xterm-256color' }, ...extra });

test('windowsShell: an absolute ComSpec/COMSPEC, otherwise cmd.exe from PATH', () => {
  assert.equal(windowsShell({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }), 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(windowsShell({ COMSPEC: 'D:/tools/cmd.exe' }), 'D:/tools/cmd.exe');
  assert.equal(windowsShell({ ComSpec: 'C:\\a.exe', COMSPEC: 'C:\\b.exe' }), 'C:\\a.exe', 'ComSpec first');
  for (const candidate of [undefined, '', 'cmd.exe', '..\\cmd.exe', '\\\\server\\share\\cmd.exe', '/bin/sh', 'C:cmd.exe']) {
    assert.equal(windowsShell(candidate === undefined ? {} : { ComSpec: candidate }), 'cmd.exe', `relative or UNC ComSpec ${JSON.stringify(candidate)} is not used`);
  }
  if (windows) assert.match(windowsShell(), /^[a-zA-Z]:[\\/].*cmd\.exe$/i, 'the runner has an absolute ComSpec');
});

test('capability: node-pty present is protection none; absent is unavailable with a reason', () => {
  assert.deepEqual(windowsTerminalCapability(() => fakeNodePty()), { available: true, protection: 'none' });
  assert.deepEqual(windowsTerminalCapability(() => undefined), { available: false, reason: 'node_pty_unavailable' });
  // The default loader agrees with whether node-pty actually loads here.
  assert.equal(windowsTerminalCapability().available, loadNodePty() !== undefined);
  assert.equal(loadNodePty(), loadNodePty(), 'loaded once');
});

test('spawn: ConPTY with exactly the PTY options; no daemon-only option leaks to node-pty', () => {
  const fake = fakeNodePty();
  const controller = new AbortController();
  const pty = createWindowsPtySpawn(() => fake)('C:\\Windows\\system32\\cmd.exe', ['/d'], spawnOptions({ killGraceMs: 5, signal: controller.signal, protection: 'none' }));
  assert.equal(fake.calls.spawn.length, 1);
  const { file, args, options } = fake.calls.spawn[0];
  assert.equal(file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(args, ['/d']);
  assert.deepEqual(options, { name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: { TERM: 'xterm-256color' }, useConpty: true });
  assert.equal(pty.pid, 4243);
  assert.equal(pty.cleanup, undefined, 'no native cleanup: the service kills the pty (best-effort)');
});

test('spawn error paths: cancelled before load, node-pty missing, node-pty spawn failure', () => {
  let loads = 0;
  const controller = new AbortController(); controller.abort();
  assert.throws(() => createWindowsPtySpawn(() => { loads++; return fakeNodePty(); })('cmd.exe', [], spawnOptions({ signal: controller.signal })), /Terminal startup cancelled/);
  assert.equal(loads, 0, 'a cancelled startup never loads or spawns');
  assert.throws(() => createWindowsPtySpawn(() => undefined)('cmd.exe', [], spawnOptions()), /node-pty is unavailable on this host/);
  const failure = new Error('File not found: ');
  assert.throws(() => createWindowsPtySpawn(() => fakeNodePty({ spawnError: failure }))('nope.exe', [], spawnOptions()), error => error === failure);
});

test('kill: once, without a signal (node-pty refuses signals on Windows); later writes and resizes are dropped', () => {
  const fake = fakeNodePty();
  const pty = createWindowsPtySpawn(() => fake)('cmd.exe', [], spawnOptions());
  pty.write('dir\r');
  pty.resize(100, 30);
  fake.resizeThrows = true;
  assert.doesNotThrow(() => pty.resize(120, 40), 'a resize racing exit is swallowed');
  fake.killThrows = true;
  assert.doesNotThrow(() => pty.kill(), 'killing an exited pty is swallowed');
  pty.kill();
  pty.write('after\r');
  pty.resize(90, 20);
  assert.deepEqual(fake.calls.write, ['dir\r']);
  assert.deepEqual(fake.calls.resize, [[100, 30], [120, 40]]);
  assert.deepEqual(fake.calls.kill, [[]], 'one kill, no signal argument');
});

test('data and exit listeners: output passes through; exit carries only exitCode and signal', () => {
  const fake = fakeNodePty();
  const pty = createWindowsPtySpawn(() => fake)('cmd.exe', [], spawnOptions());
  const output = []; const exits = [];
  const data = pty.onData(text => output.push(text));
  pty.onExit(event => exits.push(event));
  fake.emit('Microsoft Windows\r\n');
  data.dispose();
  fake.emit('dropped');
  fake.exit({ exitCode: 3221225786, signal: undefined, extra: 'ignored' });
  assert.deepEqual(output, ['Microsoft Windows\r\n']);
  assert.deepEqual(exits, [{ exitCode: 3221225786, signal: undefined }]);
});

test('terminal.json on win32: POSIX mode bits are not checked; a directory or symlink is still refused', async t => {
  const dir = await home(t, null);
  const file = path.join(dir, 'terminal.json');
  assert.equal((await readTerminalConfig(dir, quiet, 'win32')).reason, 'missing');
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o644 });
  // alpd does not read Windows ACLs: a regular file of this user in ALP_HOME (the profile) turns terminals on.
  assert.equal((await readTerminalConfig(dir, quiet, 'win32')).enabled, true, 'win32 ignores POSIX group/other bits');
  if (!windows) assert.equal((await readTerminalConfig(dir, quiet, 'linux')).reason, 'not_private', 'the same file is refused on POSIX');
  await rm(file);
  await mkdir(file);
  assert.equal((await readTerminalConfig(dir, quiet, 'win32')).reason, 'not_private', 'a directory is not the switch');
  await rm(file, { recursive: true });
  await writeFile(path.join(dir, 'elsewhere.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }));
  try { await symlink(path.join(dir, 'elsewhere.json'), file); } catch (error) {
    if (windows && error.code === 'EPERM') { t.diagnostic('symlink needs Developer Mode or admin on this runner; symlink case skipped'); return; }
    throw error;
  }
  assert.equal((await readTerminalConfig(dir, quiet, 'win32')).reason, 'not_private', 'a symlink is not the switch');
});

/** The real service on platform win32 over a fake node-pty: the production path minus the native module. */
async function service(t, { fake = fakeNodePty(), config, load } = {}) {
  const dir = await home(t, config);
  const loader = load ?? (() => fake);
  const terminals = createTerminalService({ home: dir, resolveWorkspace: async () => dir, log: quiet, platform: 'win32', spawn: createWindowsPtySpawn(loader), capability: () => windowsTerminalCapability(loader), processes: async () => [], sweepMs: 60000, killGraceMs: 1 });
  t.after(() => terminals.shutdown());
  return { dir, fake, terminals };
}
const create = (terminals, requestId = 'r1') => terminals.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId });

test('service on win32: protection none, the Windows shell, no private ALP env; close kills the pty once', async t => {
  const { dir, fake, terminals } = await service(t);
  const { terminal } = await create(terminals);
  assert.equal(terminal.protection, 'none', 'clients disclose the best-effort limit');
  const { file, args, options } = fake.calls.spawn[0];
  assert.equal(file, windowsShell());
  assert.deepEqual(args, []);
  assert.equal(options.cwd, dir);
  assert.equal(options.useConpty, true);
  assert.equal(options.env.TERM, 'xterm-256color');
  assert.equal(options.env.ALP_TERMINAL, '1');
  assert.deepEqual(Object.keys(options.env).filter(key => /^(ALP_|npm_)/i.test(key)).sort(), ['ALP_TERMINAL', 'ALP_TERMINAL_ID']);
  const events = [];
  const sink = { send(message) { events.push(message.params); } };
  await terminals.attach(owner, sink, { terminalId: terminal.terminalId });
  await terminals.input(owner, sink, { terminalId: terminal.terminalId, data: 'echo hi\r' });
  await terminals.resize(owner, sink, { terminalId: terminal.terminalId, cols: 100, rows: 30 });
  fake.emit('hi\r\n');
  assert.deepEqual(fake.calls.write, ['echo hi\r']);
  assert.deepEqual(fake.calls.resize, [[100, 30]]);
  assert.deepEqual(events.filter(event => event.type === 'output').map(event => event.data), ['hi\r\n']);
  assert.deepEqual(await terminals.close(owner, { terminalId: terminal.terminalId }), { closed: true });
  assert.deepEqual(fake.calls.kill, [[]], 'closing kills the pty, without a signal');
  assert.equal(events.at(-1).type, 'exit');
  assert.equal(events.at(-1).reason, 'closed');
  fake.exit({ exitCode: 1 });
  assert.equal(events.filter(event => event.type === 'exit').length, 1, 'a late node-pty exit adds no second exit event');
  assert.deepEqual((await terminals.list(owner, {})).terminals, []);
});

test('service on win32: a shell that exits on its own ends the terminal; shutdown kills the rest', async t => {
  const { fake, terminals } = await service(t);
  const { terminal } = await create(terminals, 'self');
  fake.exit({ exitCode: 0, signal: 0 });
  const [listed] = (await terminals.list(owner, {})).terminals;
  assert.deepEqual([listed.state, listed.exitCode, listed.endReason], ['exited', 0, 'exited']);
  await create(terminals, 'second');
  await terminals.shutdown();
  assert.equal(fake.calls.kill.length, 2, 'the exited pty is still killed once on reap; the running one on shutdown');
  assert.equal(terminal.protection, 'none');
});

test('service on win32 error paths: switch off, node-pty missing, node-pty spawn failure', async t => {
  const off = await service(t, { config: null });
  await assert.rejects(create(off.terminals), error => error.data?.reason === 'terminal_disabled');
  assert.equal(off.fake.calls.spawn.length, 0, 'never spawned while off');

  const missing = await service(t, { load: () => undefined });
  await assert.rejects(create(missing.terminals), error => error.data?.reason === 'terminal_unsupported');
  assert.equal(await missing.terminals.advertised(), undefined, 'no terminal capability is advertised without node-pty');

  const failing = await service(t, { fake: fakeNodePty({ spawnError: new Error('CreateProcess failed: C:\\secret\\path') }) });
  await assert.rejects(create(failing.terminals), error => error.data?.reason === 'terminal_unsupported' && !String(error.message).includes('secret'), 'a node-pty failure is refused as unsupported, without its text');
  assert.deepEqual((await failing.terminals.list(owner, {})).terminals, []);
});

// --- Real ConPTY (Windows only) ---------------------------------------------------------------

test('ConPTY: node-pty loads on this Windows host', { skip: conpty }, () => {
  assert.ok(loadNodePty(), 'node-pty (optional dependency) must load on the Windows CI runner');
  assert.deepEqual(windowsTerminalCapability(), { available: true, protection: 'none' });
});

test('ConPTY: a real cmd.exe echoes, resizes and is killed by the owner', { skip: conpty, timeout: 60000 }, async t => {
  const shell = windowsShell();
  const pty = windowsPtySpawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: await realpath(tmpdir()), env: { ...process.env, TERM: 'xterm-256color' } });
  t.after(() => pty.kill());
  let output = '';
  pty.onData(text => { output += text; });
  let exit;
  pty.onExit(event => { exit = event; });
  assert.ok(Number.isInteger(pty.pid) && pty.pid > 0);
  assert.equal(alive(pty.pid), true, 'the shell runs');
  // The caret keeps the typed command (echoed by ConPTY) from matching: only cmd.exe's output does.
  pty.write('echo ALP_CON^PTY_OK\r');
  await until(() => output.includes('ALP_CONPTY_OK'), 'cmd.exe output');
  pty.resize(120, 40);
  pty.write('mode con\r');
  await until(() => /Columns:\s+120/.test(output), 'the resized console');
  pty.kill();
  await until(() => !alive(pty.pid), 'the shell to exit after kill');
  await until(() => exit !== undefined, 'the node-pty exit event');
  t.diagnostic(`ConPTY shell ${shell} pid ${pty.pid} exited after kill with ${JSON.stringify(exit)}`);
  assert.doesNotThrow(() => { pty.write('ignored\r'); pty.resize(80, 24); pty.kill(); }, 'the owner is inert after kill');
});

test('ConPTY: the terminal service end to end on Windows (terminal.json, create, attach, input, close)', { skip: conpty, timeout: 60000 }, async t => {
  const dir = await home(t, null);
  // Written like `alp terminal allow` (mode 0o600, which Windows ignores): the default profile ACL applies.
  await writeFile(path.join(dir, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  assert.equal((await readTerminalConfig(dir, quiet)).enabled, true, 'a regular file of this user in ALP_HOME turns terminals on');
  const terminals = createTerminalService({ home: dir, resolveWorkspace: async () => dir, log: quiet, sweepMs: 60000 });
  t.after(() => terminals.shutdown());
  const { terminal } = await create(terminals, 'conpty');
  assert.equal(terminal.protection, 'none');
  const [pid] = terminals.pids();
  assert.equal(alive(pid), true);
  let output = '';
  const sink = { send(message) { if (message.params?.type === 'output') output += message.params.data; } };
  await terminals.attach(owner, sink, { terminalId: terminal.terminalId });
  await terminals.input(owner, sink, { terminalId: terminal.terminalId, data: 'echo %ALP_TERMINAL%_SERVICE^_OK\r' });
  await until(() => output.includes('1_SERVICE_OK'), 'service terminal output with the terminal environment');
  await terminals.close(owner, { terminalId: terminal.terminalId });
  await until(() => !alive(pid), 'the service shell to exit after close');
  t.diagnostic(`ConPTY service terminal pid ${pid} ended on close`);
  assert.deepEqual(terminals.pids(), []);
});
