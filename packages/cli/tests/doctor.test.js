import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { diagnose, repair } from '@anhlp/alp-client/doctor';
import { bootTime } from '@anhlp/alp-client';

const windows = process.platform === 'win32';

// A fake runtime. Windows cannot exec a shebang script, so there it is a .js file the doctor runs under Node,
// which `via` hands to the doctor by its variable, as a PATH lookup would not find it.
async function fakeBin(directory, name, body) {
  const file = path.join(directory, windows ? `${name}.js` : name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}
const via = (variable, file) => windows ? { [variable]: file } : {};

const byId = (checks, id) => checks.filter(check => check.id === id);

test('doctor reports runtimes, settings, agents and leftovers, and --fix repairs only what is safe', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  await mkdir(path.join(home, 'state'), { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await mkdir(bin);
  const codex = await fakeBin(bin, 'codex', "const [command] = process.argv.slice(2); if (command === '--version') console.log('codex-cli 9.9.9'); else if (command === 'login') { console.log('Not logged in'); process.exit(1); }");
  const claude = await fakeBin(bin, 'claude', "const [command] = process.argv.slice(2); if (command === '--version') console.log('9.9.9 (Claude Code)'); else if (command === 'auth') console.log('{\"loggedIn\": true}');");
  const env = { PATH: bin, ...via('ALP_CODEX_BIN', codex), ...via('ALP_CLAUDE_BIN', claude) };

  // A project with a typo in its settings, a merged branch, an unmerged one, and one in use.
  const project = path.join(directory, 'project');
  await initProject(project);
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('branch', 'alp/merged');
  git('checkout', '-q', '-b', 'alp/kept');
  await writeFile(path.join(project, 'work.txt'), 'work');
  git('add', 'work.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work');
  git('checkout', '-q', 'main');
  git('branch', 'alp/waiting');
  git('worktree', 'add', '-q', path.join(directory, 'gone-tree'), '-b', 'alp/tree');
  await rm(path.join(directory, 'gone-tree'), { recursive: true });
  const settingsFile = path.join(project, '.alp', 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, 'utf8')), workfow: {} }));

  // Leftovers in ALP_HOME: a dead alpd's lock, an open file, a skill the library lacks,
  // and interrupted work in a project that is gone.
  await writeFile(path.join(home, 'alpd.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, bootTime: bootTime(), socket: path.join(home, 'alpd.sock') }), { mode: 0o600 });
  await writeFile(path.join(home, 'state', 'recall.json'), '[]', { mode: 0o644 });
  await chmod(path.join(home, 'state', 'recall.json'), 0o644);
  await writeFile(path.join(home, 'role-skills.json'), JSON.stringify({ main: ['missing-skill'] }), { mode: 0o600 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ limits: { autoResume: 'yes' } }), { mode: 0o600 });
  const live = [
    { assignmentId: 'a-gone', agent: 'peer', project: path.join(directory, 'nowhere') },
    { assignmentId: 'a-here', agent: 'peer', project, worktree: { branch: 'alp/waiting' } },
  ];
  await writeFile(path.join(home, 'state', 'live.json'), JSON.stringify(live), { mode: 0o600 });

  const checks = await diagnose({ home, project, env, sandbox: false });
  const status = id => byId(checks, id).map(check => check.status);
  assert.deepEqual(status('codex'), ['fail']);
  assert.match(byId(checks, 'codex')[0].summary, /codex-cli 9\.9\.9 .* not logged in; run codex login/);
  assert.deepEqual(status('claude'), ['ok']);
  assert.deepEqual(status('alpd'), ['warn']);
  assert.deepEqual(status('sandbox'), ['warn']);
  // Windows has no mode bits to report or tighten; the check is ok there.
  assert.deepEqual(status('permissions'), [windows ? 'ok' : 'warn']);
  if (!windows) assert.deepEqual(byId(checks, 'permissions')[0].details, [`0644 ${path.join(home, 'state', 'recall.json')}`]);
  assert.deepEqual(status('user settings'), ['fail']);
  assert.match(byId(checks, 'user settings')[0].summary, /limits\.autoResume must be true or false/);
  assert.deepEqual(status('skills'), ['warn']);
  assert.deepEqual(status('live work'), ['warn']);
  assert.deepEqual(byId(checks, 'live work')[0].details, [`peer a-gone in ${path.join(directory, 'nowhere')}`]);
  assert.deepEqual(status('settings'), ['fail']);
  assert.match(byId(checks, 'settings')[0].summary, /workfow.*workflow/);
  assert.deepEqual(status('worktrees'), ['warn']);
  assert.deepEqual(byId(checks, 'branches').map(check => [check.status, check.details]), [['warn', ['alp/merged']], ['info', ['alp/kept']]]);

  const fixed = await repair(checks);
  assert.deepEqual(fixed.map(item => item.id), windows ? ['alpd', 'live work', 'worktrees', 'branches'] : ['alpd', 'permissions', 'live work', 'worktrees', 'branches']);
  if (!windows) assert.equal((await stat(path.join(home, 'state', 'recall.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'state', 'live.json'), 'utf8')).map(entry => entry.assignmentId), ['a-here']);
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/alp/').trim().split('\n').sort().join(' '), 'alp/kept alp/tree alp/waiting');
  assert.doesNotMatch(git('worktree', 'list'), /gone-tree/);

  const after = await diagnose({ home, project, env, sandbox: false });
  for (const id of ['alpd', 'permissions', 'live work', 'worktrees']) assert.ok(byId(after, id).every(check => check.status !== 'warn'), id);
  // alp/tree lost its worktree to the prune and is merged now; the next --fix takes it.
  assert.deepEqual(byId(after, 'branches').map(check => [check.status, check.details]), [['warn', ['alp/tree']], ['info', ['alp/kept']]]);
});

test('doctor fails without any runtime and passes a clean setup', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const none = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  assert.deepEqual(none.filter(check => check.status !== 'ok').map(check => [check.id, check.status]), [['codex', 'fail'], ['claude', 'fail'], ['antigravity', 'fail']]);

  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const codex = await fakeBin(bin, 'codex', "console.log('codex-cli 1.0.0')");
  const project = path.join(directory, 'project');
  await initProject(project);
  const checks = await diagnose({ home, project, env: { PATH: bin, ...via('ALP_CODEX_BIN', codex) }, sandbox: true });
  // Claude and Antigravity missing is fine while Codex works.
  assert.deepEqual(checks.filter(check => check.status !== 'ok').map(check => [check.id, check.status]), [['claude', 'warn'], ['antigravity', 'warn']]);
  assert.match(checks.find(check => check.id === 'agents').summary, /agents resolve: .*main/);
});

test('alp doctor --json prints the checks and exits 0 when nothing fails', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const codex = await fakeBin(bin, 'codex', "console.log('codex-cli 1.0.0')");
  const claude = await fakeBin(bin, 'claude', "if (process.argv[2] === '--version') console.log('1.0.0 (Claude Code)'); else console.log('{\"loggedIn\": true}');");
  const project = path.join(directory, 'project');
  await initProject(project);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'doctor', '--json', '--project', project], {
    env: { ...process.env, ALP_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ALP_CODEX_BIN: windows ? codex : '', ALP_CLAUDE_BIN: windows ? claude : '', ALP_ANTIGRAVITY_BIN: codex },
  }).toString();
  const report = JSON.parse(output);
  assert.equal(report.project, project);
  assert.deepEqual(report.fixed, []);
  assert.ok(report.checks.some(check => check.id === 'agents' && check.status === 'ok'));
  assert.ok(report.checks.every(check => check.status !== 'fail'), JSON.stringify(report.checks));
});

const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const jsonLine = record => JSON.stringify({ time: '2026-10-15T01:00:00.000Z', component: 'alpd', ...record });

async function privateHome(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'state', 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(home, 'logs'), { mode: 0o700 });
  await chmod(home, 0o700);
  return { directory, home };
}

test('doctor diagnoses a failed start, persistence, IPC and provider trouble from the log, and quotes no secret', async t => {
  const { home, directory } = await privateHome(t);
  await writeFile(path.join(home, 'logs', 'alpd.log'), [
    `2026-10-09T00:00:00.000Z fatal Error: ANTHROPIC_API_KEY=${SECRET}`,
    jsonLine({ level: 'info', msg: 'alpd 0.10.0 ready', event: 'ready' }),
    jsonLine({ level: 'error', code: 'ALP_PERSISTENCE_WRITE_FAILED', msg: `record s1 failed: token=${SECRET}`, sessionId: 's1' }),
    jsonLine({ level: 'warn', code: 'ALP_IPC_PARSE_ERROR', component: 'alpd.ipc', msg: 'a client sent a line that is not JSON' }),
    jsonLine({ level: 'error', code: 'ALP_PROVIDER_FAILED', component: 'runtime', msg: `peer's codex session failed ${SECRET}`, sessionId: 's2', agent: 'peer' }),
    jsonLine({ level: 'error', code: 'ALP_IPC_LISTEN_FAILED', msg: 'alpd failed to start while opening its IPC endpoint', error: { name: 'Error', code: 'EADDRINUSE', message: `listen EADDRINUSE Bearer ${SECRET}` } }),
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(path.join(home, 'state', 'sessions', 'bad.json'), '{"version": 1, "id": ', { mode: 0o600 });
  await writeFile(path.join(home, 'state', 'sessions', 's2.json'), JSON.stringify({
    version: 1, id: 's2', rootId: 's2', status: 'failed', updatedAt: new Date().toISOString(), session: { agent: 'peer', runtime: 'codex' },
    lastError: { code: 'login_required', message: `codex says: token ${SECRET}` },
  }), { mode: 0o600 });

  const checks = await diagnose({ home, env: { PATH: path.join(directory, 'empty') }, timeoutMs: 200 });
  const find = id => checks.find(check => check.id === id);
  assert.equal(find('startup').status, 'fail');
  assert.match(find('startup').summary, /ALP_IPC_LISTEN_FAILED/);
  assert.match(find('startup').details[0], /EADDRINUSE/);
  assert.equal(find('persistence log').status, 'warn');
  assert.match(find('persistence log').summary, /ALP_PERSISTENCE_WRITE_FAILED x1/);
  assert.match(find('persistence log').details[0], /s1/);
  assert.match(find('ipc log').summary, /ALP_IPC_PARSE_ERROR x1/);
  assert.match(find('provider log').summary, /ALP_PROVIDER_FAILED x1/);
  assert.match(find('provider log').details[0], /session s2/);
  assert.equal(find('state').status, 'warn');
  assert.deepEqual(find('state').details.slice(0, 1), ['bad.json']);
  assert.equal(find('failed sessions').status, 'warn');
  assert.match(find('failed sessions').details[0], /peer s2 \(codex\) login_required/);
  assert.ok(!JSON.stringify(checks).includes(SECRET), 'a secret reached the doctor output');
  // A start that failed is not what a running alpd is doing.
  assert.ok(!checks.some(check => check.id === 'ipc' || check.id === 'readiness'));
});

test('doctor says an alpd that runs but cannot be reached is an IPC failure, with the code', async t => {
  const { home, directory } = await privateHome(t);
  const socket = path.join(directory, 'nowhere.sock');
  await writeFile(path.join(home, 'alpd.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 600_000).toISOString(), bootTime: bootTime(), socket, ready: true, version: '9.9.9' }), { mode: 0o600 });
  const checks = await diagnose({ home, env: { PATH: path.join(directory, 'empty') }, timeoutMs: 200 });
  assert.equal(byId(checks, 'alpd')[0].status, 'ok');
  const ipc = byId(checks, 'ipc')[0];
  assert.equal(ipc.status, 'fail');
  assert.match(ipc.summary, /running but cannot be reached.*ALP_IPC_SOCKET_MISSING/);
  assert.equal(byId(checks, 'readiness').length, 0);
});

test('doctor only diagnoses: nothing is changed without --fix, and --fix keeps sessions, tasks, timelines and what it drops', async t => {
  const { home, directory } = await privateHome(t);
  const project = path.join(directory, 'project');
  await initProject(project);
  const keep = {
    [path.join(home, 'state', 'sessions', 's1.json')]: JSON.stringify({ version: 1, id: 's1', rootId: 's1', status: 'idle' }),
    [path.join(home, 'state', 'timeline', 's1.jsonl')]: '{"cursor":1}\n{"cursor":2',
    [path.join(home, 'state', 'receipts', 'r1.json')]: '{"version":1}',
    [path.join(home, 'state', 'live.json')]: JSON.stringify([{ assignmentId: 'a-gone', agent: 'peer', project: path.join(directory, 'nowhere') }]),
    [path.join(project, '.alp', 'tasks', 't1.json')]: '{"id":"t1"}',
  };
  for (const [file, body] of Object.entries(keep)) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, body, { mode: 0o600 });
  }
  const lockFile = path.join(home, 'alpd.lock');
  await writeFile(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, bootTime: bootTime(), socket: path.join(home, 'alpd.sock') }), { mode: 0o600 });
  const unchanged = async () => { for (const [file, body] of Object.entries(keep)) assert.equal(await readFile(file, 'utf8'), body, file); };

  const run = args => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'doctor', '--json', '--project', project, ...args], {
    env: { ...process.env, ALP_HOME: home, PATH: path.join(directory, 'empty') }, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString());
  // Not even the dead alpd's lock goes without --fix; the exit code 1 is the missing runtimes.
  const plain = (() => { try { return run([]); } catch (error) { return JSON.parse(error.stdout.toString()); } })();
  assert.deepEqual(plain.fixed, []);
  assert.ok(plain.checks.some(check => check.fix), 'the repairs are offered');
  assert.equal(await readFile(lockFile, 'utf8').then(() => true, () => false), true);
  await unchanged();

  const checks = await diagnose({ home, project, env: { PATH: path.join(directory, 'empty') } });
  const fixed = await repair(checks);
  assert.ok(fixed.some(item => item.id === 'live work'));
  // The stale lock goes; everything that holds work stays, and the dropped assignment is kept beside live.json.
  assert.equal(await readFile(lockFile, 'utf8').then(() => true, () => false), false);
  for (const file of Object.keys(keep).filter(file => !file.endsWith('live.json'))) assert.equal(await readFile(file, 'utf8'), keep[file]);
  const dropped = (await readdir(path.join(home, 'state'))).filter(name => /^live\.json\.dropped-\d+\.json$/.test(name));
  assert.equal(dropped.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'state', dropped[0]), 'utf8')).map(entry => entry.assignmentId), ['a-gone']);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'state', 'live.json'), 'utf8')), []);
});

test('doctor --json and error output stay machine readable and scrubbed', async t => {
  const { home, directory } = await privateHome(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, ALP_HOME: home, PATH: path.join(directory, 'empty'), ANTHROPIC_API_KEY: SECRET };
  let result;
  try { result = { stdout: execFileSync(process.execPath, [cli, 'doctor', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString(), stderr: '' }; }
  catch (error) { result = { stdout: error.stdout.toString(), stderr: error.stderr.toString() }; }
  // Stdout is one JSON document and nothing else.
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.ok(!result.stdout.includes(SECRET));
  // A failing command prints its error scrubbed, on stderr.
  const failing = (() => { try { execFileSync(process.execPath, [cli, 'task', 'show', `Bearer-${SECRET}`], { env, stdio: ['ignore', 'pipe', 'pipe'] }); return { stderr: '', stdout: '' }; } catch (error) { return { stderr: error.stderr.toString(), stdout: error.stdout.toString() }; } })();
  assert.ok(!failing.stderr.includes(SECRET) && !failing.stdout.includes(SECRET));
});
