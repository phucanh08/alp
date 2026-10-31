// What an operator can learn about alpd from its log and from alp doctor (ALPD §67): a failed start,
// an alpd that runs but is not reachable or not ready, and a log that never lands in the ACP stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertPrivateDirectory, bootTime, daemonPaths, ensureDaemon } from '../../packages/client/src/index.js';
import { diagnose, diskCheck, shellQuote } from '../../packages/client/src/doctor.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';
import { createDaemonServer, createStore } from '../../dist/daemon/index.js';

const ALPD = fileURLToPath(new URL('../../dist/alpd.js', import.meta.url));
const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));
const run = promisify(execFile);
const skip = process.platform === 'win32' && 'POSIX modes and sockets only';
const realpathOf = file => realpath(file);
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

async function privateHome(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-diag-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  return { directory, home };
}

/** Runs alpd the way its detached launcher leaves it: output to its log file. Resolves with its exit. */
async function alpd(home, args = []) {
  const log = openSync(daemonPaths(home).log, 'a', 0o600);
  const child = spawn(process.execPath, [ALPD, ...args], { stdio: ['ignore', log, log], env: { ...process.env, ALP_HOME: home, ANTHROPIC_API_KEY: SECRET } });
  closeSync(log);
  const [code] = await once(child, 'exit');
  return code;
}

const records = async home => (await readFile(daemonPaths(home).log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a start that cannot open its IPC endpoint says so in the log and doctor reads it', { skip }, async t => {
  const { home, directory } = await privateHome(t);
  // Something that is not a socket sits where alpd's endpoint goes.
  const { socket } = daemonPaths(home);
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  await writeFile(socket, 'in the way', { mode: 0o600 });
  assert.equal(await alpd(home), 1);
  const failure = (await records(home)).find(record => record.level === 'error');
  assert.deepEqual([failure.component, failure.code, failure.phase], ['alpd', 'ALP_IPC_LISTEN_FAILED', 'listen']);
  assert.match(failure.error.message, /socket/i);
  assert.match(failure.time, /^\d{4}-\d\d-\d\dT/);
  assert.ok(!(await readFile(daemonPaths(home).log, 'utf8')).includes(SECRET));

  const checks = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  const startup = checks.find(check => check.id === 'startup');
  assert.equal(startup.status, 'fail');
  assert.match(startup.summary, /ALP_IPC_LISTEN_FAILED/);
});

test('a launcher that fails at once reports why, in its error and not only in a log', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  // Admission accepts the home; the real launcher fails while preparing its log directory.
  // Not empty, so alpd does not tighten it (t-37f1).
  await writeFile(path.join(home, 'logs', 'old.log'), '');
  await chmod(path.join(home, 'logs'), 0o755);
  await assert.rejects(ensureDaemon({ home, entry: ALPD, timeoutMs: 2000 }), error => /launcher exited \(1\): ALP_HOME_UNUSABLE, alpd failed to start while preparing its home/.test(error.message) && !error.message.includes(SECRET));
});

test('startup admission reports an unusable home before launching a child', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  await chmod(home, 0o755);
  await assert.rejects(ensureDaemon({ home, entry: path.join(directory, 'must-not-launch.js'), env: { ...process.env, ALP_HOME: home } }), error => {
    assert.equal(error.code, 'ALP_HOME_UNUSABLE');
    assert.match(error.message, /ALP_HOME_UNUSABLE.*preparing its home/);
    assert.match(error.cause.message, /private permissions/);
    assert.ok(error.cause.message.includes(`fix it with: chmod 700 '${home}'`), error.cause.message);
    return true;
  });
});

test('an empty home the user pre-created at 0755 is tightened to 0700; one that holds files is not (t-37f1)', { skip }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-diag-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const empty = path.join(directory, 'empty');
  await mkdir(empty, { mode: 0o755 });
  await chmod(empty, 0o755);
  await assertPrivateDirectory(empty, { create: true });
  assert.equal((await lstat(empty)).mode & 0o777, 0o700);
  const used = path.join(directory, 'used');
  await mkdir(used, { mode: 0o755 });
  await chmod(used, 0o755);
  await writeFile(path.join(used, 'note'), 'x');
  await assert.rejects(assertPrivateDirectory(used, { create: true }), /not 0755; fix it with: chmod 700 /);
  assert.equal((await lstat(used)).mode & 0o777, 0o755, 'a directory that holds files keeps its mode');
  // Two first starts at once: the one that finds the directory filled by the other still passes.
  const raced = path.join(directory, 'raced');
  await mkdir(raced, { mode: 0o755 });
  await chmod(raced, 0o755);
  await Promise.all([1, 2, 3].map(async n => { await assertPrivateDirectory(raced, { create: true }); await mkdir(path.join(raced, `s${n}`), { recursive: true }); }));
  assert.equal((await lstat(raced)).mode & 0o777, 0o700);
  // Without create (a check, not ALP preparing its own directory) nothing is changed.
  const checked = path.join(directory, 'checked');
  await mkdir(checked, { mode: 0o755 });
  await chmod(checked, 0o755);
  await assert.rejects(assertPrivateDirectory(checked), /chmod 700/);
  assert.equal((await lstat(checked)).mode & 0o777, 0o755);
});

test('doctor and alp daemon status tell a ready alpd, one that is not ready, and one that is gone', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const state = path.join(home, 'state');
  const runtime = createAlpRuntime({ runLogDir: path.join(directory, 'runs'), libraryDir: home });
  const store = createStore(state);
  const { socket } = daemonPaths(home);
  const server = createDaemonServer({ runtime, socketPath: socket, version: 'test', store });
  await server.listen();
  t.after(async () => { await server.close().catch(() => {}); await runtime.shutdown(); });
  const env = { ...process.env, ALP_HOME: home, PATH: path.join(directory, 'empty') };
  const status = async () => {
    try { const { stdout } = await run(process.execPath, [CLI, 'daemon', 'status', '--json'], { env }); return { code: 0, report: JSON.parse(stdout) }; }
    catch (error) { return { code: error.code, report: JSON.parse(error.stdout) }; }
  };
  const lockFile = path.join(home, 'alpd.lock');

  // Not running: no lock.
  assert.deepEqual(await status(), { code: 3, report: { running: false, live: false, ready: false } });

  await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), bootTime: bootTime(), socket, ready: true, version: 'test', protocolVersion: 1 }), { mode: 0o600 });
  const ready = await status();
  assert.equal(ready.code, 0);
  assert.deepEqual([ready.report.running, ready.report.health.live, ready.report.health.ready], [true, true, true]);
  const good = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  assert.equal(good.find(check => check.id === 'ipc').status, 'ok');
  assert.equal(good.find(check => check.id === 'readiness').status, 'ok');
  assert.equal(good.find(check => check.id === 'state').status, 'ok');

  // Alive, answering, and not ready: its state directory cannot be written.
  await store.list();
  await rename(state, `${state}.away`);
  await writeFile(state, 'not a directory');
  const broken = await status();
  assert.equal(broken.code, 4);
  assert.equal(broken.report.health.live, true);
  assert.equal(broken.report.health.ready, false);
  const bad = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  const readiness = bad.find(check => check.id === 'readiness');
  assert.equal(readiness.status, 'fail');
  assert.match(readiness.summary, /alive but not ready: ALP_STATE_NOT_WRITABLE/);
  assert.equal(bad.find(check => check.id === 'ipc').status, 'ok');
  const { stdout } = await run(process.execPath, [CLI, 'daemon', 'status'], { env }).catch(error => error);
  assert.match(stdout, /not ready: ALP_STATE_NOT_WRITABLE/);
  await rm(state);
  await rename(`${state}.away`, state);
  assert.equal((await status()).code, 0);

  // Alive by its lock, but nothing listens: the IPC check fails with its code.
  await server.close();
  const gone = await status();
  assert.equal(gone.code, 4);
  assert.equal(gone.report.checks[0].code, 'ALP_IPC_FAILED');
  const unreachable = (await diagnose({ home, env: { PATH: path.join(directory, 'empty') }, timeoutMs: 500 })).find(check => check.id === 'ipc');
  assert.equal(unreachable.status, 'fail');
  assert.match(unreachable.summary, /cannot be reached.*ALP_IPC_(SOCKET_MISSING|REFUSED)/);
});

test('alp acp keeps stdout to protocol frames and puts structured, scrubbed diagnostics on stderr', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  // alpd cannot start in a home others can read, so the editor's request fails.
  await chmod(home, 0o755);
  const child = spawn(process.execPath, [CLI, 'acp'], { env: { ...process.env, ALP_HOME: home, ANTHROPIC_API_KEY: SECRET, ALP_DAEMON_ENTRY: ALPD }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => err.push(chunk));
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: directory, mcpServers: [] } },
  ];
  for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
  const deadline = Date.now() + 15_000;
  while (!Buffer.concat(out).toString().includes('"id":2') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  child.stdin.end();
  await once(child, 'exit');

  const stdout = Buffer.concat(out).toString().split('\n').filter(Boolean);
  assert.ok(stdout.length >= 2);
  for (const line of stdout) assert.equal(JSON.parse(line).jsonrpc, '2.0', `stdout carried a line that is not a protocol frame: ${line}`);
  assert.ok(JSON.parse(stdout.find(line => line.includes('"id":2'))).error);
  const stderr = Buffer.concat(err).toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const failure = stderr.find(record => record.code === 'ALP_IPC_CONNECT_FAILED');
  assert.deepEqual([failure.component, failure.level], ['acp', 'warn']);
  assert.match(failure.error.message, /ALP_HOME_UNUSABLE/);
  assert.ok(!stdout.join('\n').includes(SECRET) && !JSON.stringify(stderr).includes(SECRET));
});

test('alp doctor reports free disk space and the worktrees earlier runs left, deleting none (t-2831)', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const temp = path.join(directory, 'tmp');
  await mkdir(path.join(home, 'worktrees', 'alp-child-1'), { recursive: true });
  await writeFile(path.join(home, 'worktrees', 'alp-child-1', 'big'), 'x'.repeat(64 * 1024));
  await mkdir(path.join(temp, 'alp-group14'), { recursive: true });
  await mkdir(path.join(temp, 'other'), { recursive: true });
  const low = await diskCheck(home, { free: 1.2 * 1024 ** 3, tempDirs: [temp] });
  assert.equal(low.status, 'warn');
  assert.match(low.summary, /^1\.2 GB free where ALP_HOME lives; when the disk is full, alpd pauses all work until space returns$/);
  assert.equal(low.details.length, 3);
  assert.match(low.details[0], /^1 left in .*worktrees, \d+ (MB|GB)$/);
  assert.match(low.details[1], /^1 left in .*alp-\*/);
  // Neither is a git checkout: unknown, with no command (t-e80a).
  assert.match(low.details[2], /^2 unknown \(/);
  assert.deepEqual(low.leftovers.map(entry => [path.basename(entry.path), entry.state, entry.command]), [['alp-child-1', 'unknown', undefined], ['alp-group14', 'unknown', undefined]]);
  assert.match(low.hint, /ALP deletes none of these/);
  const plenty = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp] });
  assert.equal(plenty.status, 'ok');
  assert.equal(plenty.details.length, 3);
  assert.equal(plenty.summary, '50.0 GB free where ALP_HOME lives');
  assert.equal((await diskCheck(path.join(directory, 'empty-home'), { free: 50 * 1024 ** 3, tempDirs: [] })).status, 'ok');
  // Nothing was removed.
  await readFile(path.join(home, 'worktrees', 'alp-child-1', 'big'));
  const checks = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  assert.equal(checks.find(check => check.id === 'disk').id, 'disk');
});

test('alp doctor classifies leftover worktrees and suggests a command only for clean and pushed ones (t-e80a)', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const temp = path.join(directory, 'tmp');
  await mkdir(temp, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'ALP', GIT_AUTHOR_EMAIL: 'alp@example.invalid', GIT_COMMITTER_NAME: 'ALP', GIT_COMMITTER_EMAIL: 'alp@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig') };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const origin = path.join(directory, 'origin.git');
  const main = path.join(directory, 'main');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  await run('git', ['init', '-q', '-b', 'main', main], { env });
  await writeFile(path.join(main, 'a.txt'), 'a\n');
  await writeFile(path.join(main, '.gitignore'), '.env\nnode_modules/\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-qm', 'first');
  await git(main, 'remote', 'add', 'origin', origin);
  await git(main, 'push', '-q', 'origin', 'main');
  const worktree = async (where, name) => { const target = path.join(where, name); await git(main, 'worktree', 'add', '-q', '-b', name, target, 'main'); return target; };
  const clean = await worktree(temp, 'alp-clean');
  const dirty = await worktree(temp, 'alp-dirty');
  await writeFile(path.join(dirty, 'new.txt'), 'untracked\n');
  const unpushed = await worktree(path.join(home, 'worktrees'), 'alp-unpushed');
  await writeFile(path.join(unpushed, 'b.txt'), 'b\n');
  await git(unpushed, 'add', '.');
  await git(unpushed, 'commit', '-qm', 'local only');
  // Only an ignored .env, which git status does not show and exists nowhere else: local-only, never clean.
  const ignored = await worktree(temp, 'alp-ignored');
  await writeFile(path.join(ignored, '.env'), 'SECRET=1\n');
  // Only an ignored node_modules: local-only too. Any ignored file keeps a checkout, with no command.
  const modules = await worktree(temp, 'alp-modules');
  await mkdir(path.join(modules, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(path.join(modules, 'node_modules', 'left-pad', 'index.js'), '\n');
  // A file marked assume-unchanged hides its changes from git status: unknown.
  const hidden = await worktree(temp, 'alp-hidden');
  await git(hidden, 'update-index', '--assume-unchanged', 'a.txt');
  await writeFile(path.join(hidden, 'a.txt'), 'changed but hidden\n');
  const live = await worktree(path.join(home, 'worktrees'), 'alp-live');
  await mkdir(path.join(home, 'state'), { recursive: true });
  await writeFile(path.join(home, 'state', 'live.json'), JSON.stringify([{ assignmentId: 'a1', worktree: { path: live } }]));
  // A standalone clone: clean and pushed, then one with a stash, which is unpushed.
  const clone = path.join(temp, 'alp-clone');
  await run('git', ['clone', '-q', origin, clone], { env });
  const stashed = path.join(temp, 'alp-stashed');
  await run('git', ['clone', '-q', origin, stashed], { env });
  await writeFile(path.join(stashed, 'a.txt'), 'changed\n');
  await git(stashed, 'stash', '-q');
  // A clone whose branches are pushed but which holds a tag on a commit no remote has: unpushed.
  const tagged = path.join(temp, 'alp-tagged');
  await run('git', ['clone', '-q', origin, tagged], { env });
  await git(tagged, 'checkout', '-q', '--detach');
  await writeFile(path.join(tagged, 'a.txt'), 'tagged\n');
  await git(tagged, 'commit', '-qam', 'tagged only');
  await git(tagged, 'tag', 'local-only');
  await git(tagged, 'checkout', '-q', 'main');
  await mkdir(path.join(temp, 'alp-plain'));
  // Every fixture is minutes old; recentMs 0 lets them be judged by their git state alone.
  const fresh = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory });
  for (const name of ['alp-clean', 'alp-clone']) assert.deepEqual(fresh.leftovers.filter(entry => entry.path.endsWith(name)).map(entry => [entry.state, entry.reason, entry.command]), [['in-use', 'changed in the last day', undefined]]);
  const check = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, recentMs: 0 });
  const states = Object.fromEntries(check.leftovers.map(entry => [path.basename(entry.path), entry.state]));
  assert.deepEqual(states, {
    'alp-unpushed': 'unpushed', 'alp-live': 'in-use', 'alp-clean': 'clean-pushed', 'alp-dirty': 'dirty', 'alp-ignored': 'local-only', 'alp-modules': 'local-only', 'alp-hidden': 'unknown',
    'alp-clone': 'clean-pushed', 'alp-stashed': 'unpushed', 'alp-tagged': 'unpushed', 'alp-plain': 'unknown',
  });
  const reasons = Object.fromEntries(check.leftovers.map(entry => [path.basename(entry.path), entry.reason]));
  assert.equal(reasons['alp-ignored'], 'ignored files: .env');
  assert.equal(reasons['alp-modules'], 'ignored files: node_modules/');
  assert.match(reasons['alp-hidden'], /assume-unchanged/);
  const commands = check.leftovers.filter(entry => entry.command).map(entry => entry.command).sort();
  assert.deepEqual(commands, [
    `git -C '${await realpathOf(main)}' worktree remove '${await realpathOf(clean)}'`,
    `rm -rf '${await realpathOf(clone)}'`,
  ].sort());
  assert.ok(check.details.some(line => line.startsWith('2 clean and pushed (no changes, no untracked or ignored files')));
  assert.ok(check.details.some(line => line.startsWith('2 local-only data (ignored files such as .env')));
  assert.ok(!check.details.some(line => /nothing would be lost/.test(line)));
  for (const state of ['dirty', 'in use']) assert.ok(check.details.some(line => line.startsWith(`1 ${state} (`)), state);
  assert.ok(check.details.some(line => line.startsWith('2 unknown (')));
  assert.ok(check.details.some(line => line.startsWith('3 unpushed (')));
  // On Windows the commands are for PowerShell.
  const windows = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, recentMs: 0, platform: 'win32' });
  assert.equal(windows.leftovers.find(entry => entry.path.endsWith('alp-clone')).command, `Remove-Item -LiteralPath '${await realpathOf(clone)}' -Recurse -Force`);
  for (const command of commands) assert.ok(check.details.includes(`  ${command}`));
  // A clean clone that other worktrees were made from holds their repository: in use, no command.
  const parent = path.join(temp, 'alp-parent');
  await run('git', ['clone', '-q', origin, parent], { env });
  await git(parent, 'worktree', 'add', '-q', '--detach', path.join(directory, 'elsewhere'), 'HEAD');
  const shared = (await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, recentMs: 0 })).leftovers.find(entry => entry.path.endsWith('alp-parent'));
  assert.deepEqual([shared.state, shared.reason, shared.command], ['in-use', 'other worktrees use its repository', undefined]);
  await rm(parent, { recursive: true, force: true });
  // Running doctor from inside a leftover keeps it.
  const inside = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: path.join(clone), recentMs: 0 });
  assert.equal(inside.leftovers.find(entry => entry.path.endsWith('alp-clone')).state, 'in-use');
  // Report only: every leftover is still there, with its changes.
  for (const target of [clean, dirty, ignored, modules, hidden, unpushed, live, clone, stashed, tagged]) await lstat(target);
  assert.equal(await readFile(path.join(ignored, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(await readFile(path.join(dirty, 'new.txt'), 'utf8'), 'untracked\n');
  // A clean worktree whose branch gained a commit no remote has is unpushed, not clean.
  await writeFile(path.join(clean, 'c.txt'), 'c\n');
  await git(clean, 'add', '.');
  await git(clean, 'commit', '-qm', 'not pushed');
  assert.equal((await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, recentMs: 0 })).leftovers.find(entry => entry.path.endsWith('alp-clean')).state, 'unpushed');
  // Out of time: nothing more is classified, and what was not reached is unknown, never clean.
  const late = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, classifyMs: 0, recentMs: 0 });
  assert.ok(late.leftovers.every(entry => entry.state === 'unknown' && /^not checked/.test(entry.reason) && !entry.command));
  assert.ok(late.details.includes('  11 of the unknown were not checked within 0 ms'));
  // The suggested command is one the user can paste as it is; git keeps the branch.
  await run('sh', ['-c', commands.find(command => command.includes('worktree remove'))], { env });
  await assert.rejects(lstat(clean), { code: 'ENOENT' });
  assert.match((await git(main, 'branch', '--list', 'alp-clean')).stdout, /alp-clean/);
});

/** How PowerShell's own parser reads `command`: each statement's command elements as [kind, value]; undefined without pwsh. */
async function powershellParse(command) {
  const script = [
    '$tokens = $null; $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:ALP_PS_COMMAND, [ref]$tokens, [ref]$errors)',
    'if ($errors.Count) { ConvertTo-Json -Compress @{ errors = @($errors | ForEach-Object { $_.Message }) }; exit 0 }',
    '$statements = @($ast.EndBlock.Statements | ForEach-Object { ,@($_.PipelineElements | ForEach-Object { ,@($_.CommandElements | ForEach-Object { if ($_ -is [System.Management.Automation.Language.CommandParameterAst]) { ,@("parameter", $_.ParameterName) } elseif ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { ,@($_.StringConstantType.ToString(), $_.Value) } else { ,@($_.GetType().Name, $_.Extent.Text) } }) }) })',
    'ConvertTo-Json -Compress -Depth 6 @{ statements = $statements }',
  ].join('\n');
  try {
    const { stdout } = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ALP_PS_COMMAND: command } });
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

test('shellQuote gives a command only for plain ASCII absolute paths, on sh and PowerShell alike (t-e80a)', async t => {
  // Safe: ASCII letters, digits, . _ - / \ : and space, in an absolute path; nothing needs escaping.
  assert.equal(shellQuote('/tmp/alp-a b/c_d.e-f:1', 'linux'), "'/tmp/alp-a b/c_d.e-f:1'");
  assert.equal(shellQuote('C:\\Users\\John Doe\\alp-1', 'win32'), "'C:\\Users\\John Doe\\alp-1'");
  assert.equal(shellQuote('\\\\server\\share\\alp-1', 'win32'), "'\\\\server\\share\\alp-1'");
  // Hostile or merely unusual: every quote PowerShell honours, shell syntax, control and format
  // characters, a newline, non-ASCII letters, a relative path or one that reads as an option. No command.
  const hostile = [
    "/tmp/alp-x'; calc; '", '/tmp/alp-x\u2018; calc; \u2018', '/tmp/alp-x\u2019; calc; \u2019', '/tmp/alp-x\u201A; calc; \u201A', '/tmp/alp-x\u201B; calc; \u201B',
    '/tmp/alp-"x"', '/tmp/alp-$(id)', '/tmp/alp-`id`', '/tmp/alp-a;b', '/tmp/alp-a&b', '/tmp/alp-a|b', '/tmp/alp-a>b', '/tmp/alp-~', '/tmp/alp-a*b', '/tmp/alp-a#b',
    '/tmp/alp-a\nb', '/tmp/alp-a\rb', '/tmp/alp-a\tb', '/tmp/alp-a\u0007b', '/tmp/alp-a\u007Fb', '/tmp/alp-a\u0085b', '/tmp/alp-a\u2028b', '/tmp/alp-a\u202Eb', '/tmp/alp-a\u200Bb', '/tmp/alp-a\u00A0b', '/tmp/alp-a\uFEFFb',
    '/tmp/alp-Phúc', 'alp-relative', '-rf', '',
  ];
  for (const text of hostile) for (const platform of ['win32', 'linux', 'darwin']) assert.equal(shellQuote(text, platform), undefined, JSON.stringify([text, platform]));
  // Where PowerShell is installed (GitHub's Linux runners), its own parser reads each safe command as one command with the path as one literal argument.
  for (const directory of ['C:\\Users\\John Doe\\alp-1', '/tmp/alp-a b/c_d.e-f:1', '\\\\server\\share\\alp-1']) {
    const parsed = await powershellParse(`Remove-Item -LiteralPath ${shellQuote(directory, 'win32')} -Recurse -Force`);
    if (!parsed) { t.diagnostic('pwsh is not installed: PowerShell parsing not checked'); return; }
    assert.deepEqual(parsed, { statements: [[[['BareWord', 'Remove-Item'], ['parameter', 'LiteralPath'], ['SingleQuoted', directory], ['parameter', 'Recurse'], ['parameter', 'Force']]]] }, directory);
    const git = await powershellParse(`git -C ${shellQuote(directory, 'win32')} worktree remove ${shellQuote(`${directory}-2`, 'win32')}`);
    assert.deepEqual(git, { statements: [[[['BareWord', 'git'], ['parameter', 'C'], ['SingleQuoted', directory], ['BareWord', 'worktree'], ['BareWord', 'remove'], ['SingleQuoted', `${directory}-2`]]]] }, directory);
  }
});

test('alp doctor gives a clean leftover with a hostile path no command, only its path (t-e80a)', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const temp = path.join(directory, 'tmp');
  await mkdir(temp, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'ALP', GIT_AUTHOR_EMAIL: 'alp@example.invalid', GIT_COMMITTER_NAME: 'ALP', GIT_COMMITTER_EMAIL: 'alp@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig') };
  const origin = path.join(directory, 'origin.git');
  const seed = path.join(directory, 'seed');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await writeFile(path.join(seed, 'a.txt'), 'a\n');
  await run('git', ['-C', seed, 'add', '.'], { env });
  await run('git', ['-C', seed, 'commit', '-qm', 'first'], { env });
  await run('git', ['-C', seed, 'push', '-q', origin, 'main'], { env });
  const hostile = ["alp-x'; touch pwned; '", 'alp-x\u2019; touch pwned; \u2018', 'alp-$(touch pwned)', 'alp-bidi\u202Etxt', 'alp-Phúc'];
  const names = ['alp-plain name', ...hostile, 'alp-new\nline'];
  for (const name of names) await run('git', ['clone', '-q', origin, path.join(temp, name)], { env });
  const real = await realpathOf(temp);
  for (const platform of ['win32', 'linux']) {
    const check = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, recentMs: 0, platform });
    const found = Object.fromEntries(check.leftovers.map(entry => [path.basename(entry.path), entry]));
    assert.equal(found['alp-plain name'].command, platform === 'win32' ? `Remove-Item -LiteralPath '${real}/alp-plain name' -Recurse -Force` : `rm -rf '${real}/alp-plain name'`);
    for (const name of hostile) {
      assert.deepEqual([found[name].state, found[name].command], ['clean-pushed', undefined], name);
      assert.match(found[name].reason, /^no command: its path holds characters other than ASCII letters/);
    }
    // A newline: git's line-by-line answer cannot name it, so it is unknown, with no command either.
    assert.deepEqual([found['alp-new\nline'].state, found['alp-new\nline'].command], ['unknown', undefined]);
    // The text lists those paths as shell comments, one line each, with format characters escaped.
    assert.ok(check.details.includes(`  # remove by hand after checking (no safe command): ${real}/alp-bidi\\u{202e}txt`), check.details.join('\n'));
    assert.ok(check.details.includes(`  # remove by hand after checking (no safe command): ${real}/alp-x'; touch pwned; '`));
    assert.ok(check.details.every(line => !/[\n\u202E]/.test(line)));
    // Pasted into sh as a whole, the listed lines run nothing but the one safe command.
    const lines = check.details.filter(line => /^ {2}(rm -rf|Remove-Item|#)/.test(line)).map(line => line.trim());
    assert.equal(lines.length, 6);
    if (platform === 'linux') await run('sh', ['-c', lines.join('\n')], { env, cwd: directory });
  }
  await assert.rejects(lstat(path.join(temp, 'alp-plain name')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(directory, 'pwned')), { code: 'ENOENT' });
  for (const name of [...hostile, 'alp-new\nline']) await lstat(path.join(temp, name));
});

test('alp doctor counts a clone with local tags or refs no remote-tracking ref mirrors as unpushed (t-e80a)', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const temp = path.join(directory, 'tmp');
  await mkdir(temp, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'ALP', GIT_AUTHOR_EMAIL: 'alp@example.invalid', GIT_COMMITTER_NAME: 'ALP', GIT_COMMITTER_EMAIL: 'alp@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig') };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const origin = path.join(directory, 'origin.git');
  const seed = path.join(directory, 'seed');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await writeFile(path.join(seed, 'a.txt'), 'a\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-qm', 'first');
  await git(seed, 'push', '-q', origin, 'main');
  const clone = async name => { const target = path.join(temp, name); await run('git', ['clone', '-q', origin, target], { env }); return target; };
  await clone('alp-plain-clone');
  // Tags on a commit the remote already has: the commit is pushed, the tag may not be.
  await git(await clone('alp-light-tag'), 'tag', 'v-light');
  await git(await clone('alp-annotated-tag'), 'tag', '-a', '-m', 'only here', 'v-annotated');
  // A branch whose commits are pushed but whose name no remote has.
  await git(await clone('alp-local-branch'), 'branch', 'only-here');
  // A note: a ref outside branches and tags.
  await git(await clone('alp-note'), 'notes', 'add', '-m', 'only here', 'HEAD');
  // A tag the remote does have: offline, git cannot tell, so it is not clean either.
  await git(seed, 'tag', 'v-remote');
  await git(seed, 'push', '-q', origin, 'v-remote');
  await clone('alp-remote-tag');
  // A clone that mirrors the remote's tags as remote-tracking refs can tell: clean and pushed.
  const mirrored = await clone('alp-mirrored-tags');
  await git(mirrored, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/remotes/origin/tags/*');
  await git(mirrored, 'fetch', '-q', 'origin');
  // The mirror names the tag, but a local tag moved to another (pushed) commit is not it.
  const moved = await clone('alp-moved-tag');
  await git(moved, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/remotes/origin/tags/*');
  await git(moved, 'fetch', '-q', 'origin');
  await git(moved, 'tag', '-f', '-a', '-m', 'retagged', 'v-remote', 'HEAD');
  const check = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], env, cwd: directory, recentMs: 0 });
  const found = Object.fromEntries(check.leftovers.map(entry => [path.basename(entry.path), [entry.state, entry.reason, Boolean(entry.command)]]));
  const unpushed = ref => ['unpushed', `local refs no remote-tracking ref mirrors: ${ref}`, false];
  assert.deepEqual(found, {
    'alp-plain-clone': ['clean-pushed', undefined, true],
    'alp-light-tag': unpushed('refs/tags/v-light'),
    'alp-annotated-tag': unpushed('refs/tags/v-annotated'),
    'alp-local-branch': unpushed('refs/heads/only-here'),
    'alp-note': ['unpushed', undefined, false],
    'alp-remote-tag': unpushed('refs/tags/v-remote'),
    'alp-mirrored-tags': ['clean-pushed', undefined, true],
    'alp-moved-tag': unpushed('refs/tags/v-remote'),
  });
});

test('alp doctor stops classifying leftovers at its deadline, even with git commands still running (t-e80a)', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const temp = path.join(directory, 'tmp');
  for (let index = 0; index < 20; index++) await mkdir(path.join(temp, `alp-${index}`, '.git'), { recursive: true });
  // A git that never answers on its own: each command ends only when its timeout cuts it off.
  const timeouts = [];
  const run = (command, args, { timeoutMs }) => {
    if (command !== 'git') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    timeouts.push(timeoutMs);
    return new Promise(resolve => setTimeout(() => resolve({ code: -1, stdout: '', stderr: 'killed' }), timeoutMs));
  };
  const started = Date.now();
  const check = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp], cwd: directory, run, classifyMs: 300, recentMs: 0 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
  assert.ok(timeouts.length > 0 && timeouts.every(ms => ms <= 300), String(timeouts));
  assert.equal(check.leftovers.length, 20);
  assert.ok(check.leftovers.every(entry => entry.state === 'unknown' && /^not checked/.test(entry.reason) && !entry.command));
  assert.ok(check.details.includes('  20 of the unknown were not checked within 300 ms'));
});
