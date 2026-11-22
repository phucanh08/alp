// alp dashboard's host owner handlers (t-a95b.1 group B, src/dashboard/owner/host.js;
// docs/alp/dashboard.md §4.7): each one reuses the CLI (alp provider add/test, alp doctor, alp
// terminal) or alpd's registry, and refuses bad values before anything runs or reaches alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseProviders, methods, ownerRegistry, projectDirectory, providerOptions, PROVIDER_CHECKS } from '../src/dashboard/owner/host.js';
import { TERMINAL_WARNING, terminalCommand } from '../src/terminal.js';

const FAKE_ACP = fileURLToPath(new URL('../../../test/support/fake-acp.js', import.meta.url));

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-owner-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  return { directory, home };
}

/** A fake alpd connection: records each request and answers from `answers`. */
function fakeDaemon(answers = {}) {
  const calls = [];
  return { calls, request: async (method, params) => { calls.push([method, params]); return typeof answers[method] === 'function' ? answers[method](params) : answers[method] ?? {}; } };
}

const call = (method, params, context) => methods[method]({ method, params, principal: 'owner', socket: '/none', daemon: fakeDaemon(), ...context });
const invalid = pattern => error => error.code === -32602 && pattern.test(error.message);

test('host.provider.add writes what alp provider add writes, create only; bad values are refused before anything is written', async t => {
  const { home } = await scratch(t);
  const saved = await call('host.provider.add', { id: 'echo-agent', command: process.execPath, args: [FAKE_ACP, '--x'], env: { FAKE_TOKEN: 's3cret=1' }, label: 'Echo', models: ['m1', 'm2'] }, { home });
  assert.equal(saved.name, 'echo-agent');
  assert.deepEqual(saved.provider, { kind: 'acp', command: process.execPath, args: [FAKE_ACP, '--x'], envKeys: ['FAKE_TOKEN'], label: 'Echo', models: ['m1', 'm2'] });
  // The same file the CLI writes for the same options (alp provider add echo-agent --command … --arg … --env … --label … --models …).
  const file = path.join(home, 'providers', 'echo-agent.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { kind: 'acp', label: 'Echo', command: process.execPath, args: [FAKE_ACP, '--x'], env: { FAKE_TOKEN: 's3cret=1' }, models: [{ id: 'm1' }, { id: 'm2' }] });
  // The answer carries env names, never values.
  assert.ok(!JSON.stringify(saved).includes('s3cret'));
  // Create only: an existing provider is never overwritten (as the CLI's add).
  await assert.rejects(call('host.provider.add', { id: 'echo-agent', command: '/bin/false' }, { home }), error => error.code === 1004 && /already exists/.test(error.message));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).command, process.execPath);
  // Refused values.
  for (const [params, pattern] of [
    [{ command: 'x' }, /id must be/],
    [{ id: 'a', command: '' }, /command must be/],
    [{ id: 'a', command: 'x', args: 'not-a-list' }, /args must be/],
    [{ id: 'a', command: 'x', args: [1] }, /args must be/],
    [{ id: 'a', command: 'x', env: { 'BAD=NAME': 'v' } }, /not a variable name/],
    [{ id: 'a', command: 'x', env: { GOOD: 1 } }, /env GOOD must be a string/],
    [{ id: 'a', command: 'x', env: ['A=1'] }, /env must be an object/],
    [{ id: 'a', command: 'x', models: ['a,b'] }, /models must be/],
    [{ id: 'a', command: 'x\0y' }, /command must be/],
  ]) await assert.rejects(call('host.provider.add', params, { home }), invalid(pattern), JSON.stringify(params));
  // A name the library refuses is a params error, not a gateway failure.
  await assert.rejects(call('host.provider.add', { id: '../escape', command: 'x' }, { home }), error => error.code === -32602 && error.data.reason === 'invalid_name');
  await assert.rejects(lstat(path.join(home, 'providers', 'a.json')));
});

test('providerOptions maps params to the CLI parser values library.js edited takes', () => {
  assert.deepEqual(providerOptions({ id: 'x', command: 'c', args: ['a'], env: { K: 'v=w' }, label: 'L', description: 'D', models: ['m'] }).values,
    { command: 'c', arg: ['a'], env: ['K=v=w'], label: 'L', description: 'D', models: 'm' });
  assert.deepEqual(providerOptions({ id: 'x', command: 'c', args: [], env: {}, models: [] }).values, { command: 'c' });
});

test('host.provider.test starts the library provider as alp provider test does; an unknown one is not found', async t => {
  const { home } = await scratch(t);
  await call('host.provider.add', { id: 'fake', command: process.execPath, args: [FAKE_ACP] }, { home });
  const result = await call('host.provider.test', { name: 'fake' }, { home });
  assert.equal(result.ok, true);
  assert.equal(result.name, 'fake');
  assert.equal(typeof result.protocolVersion, 'number');
  await assert.rejects(call('host.provider.test', { name: 'missing' }, { home }), error => typeof error.code === 'number');
  await assert.rejects(call('host.provider.test', {}, { home }), invalid(/name must be/));
});

test('host.provider.diagnose answers alp doctor\'s runtime and provider checks only', async t => {
  const { home } = await scratch(t);
  await call('host.provider.add', { id: 'gone', command: '/nonexistent/acp-agent' }, { home });
  // The runtimes point at programs that do not exist: no real codex, claude or agy runs here.
  const missing = path.join(home, 'no-such-bin');
  const env = { PATH: path.dirname(process.execPath), ALP_CODEX_BIN: missing, ALP_CLAUDE_BIN: missing, ALP_ANTIGRAVITY_BIN: missing };
  const { checks } = await diagnoseProviders(home, { env });
  assert.ok(checks.length >= 1);
  for (const check of checks) {
    assert.ok(PROVIDER_CHECKS.includes(check.id), check.id);
    assert.ok(['ok', 'warn', 'fail'].includes(check.status));
    assert.equal(typeof check.summary, 'string');
    assert.equal(check.fix, undefined);
  }
  const providers = checks.find(check => check.id === 'providers');
  assert.match(providers.summary, /gone/);
  assert.ok(providers.details.some(line => /gone: \/nonexistent\/acp-agent is not found/.test(line)));
  for (const runtime of ['codex', 'claude', 'antigravity']) assert.equal(checks.find(check => check.id === runtime)?.status, 'fail', runtime);
});

test('host.terminal.set: allow needs confirm, writes what alp terminal allow --yes writes; deny turns it off; status says so', async t => {
  const { home } = await scratch(t);
  const file = path.join(home, 'terminal.json');
  let status = await call('host.terminal.status', {}, { home });
  assert.equal(status.allowRemoteTerminal, false);
  assert.equal(status.warning, TERMINAL_WARNING());
  await assert.rejects(call('host.terminal.set', { allow: true }, { home }), error => error.code === -32602 && error.data.reason === 'confirm_required' && error.data.warning === TERMINAL_WARNING());
  await assert.rejects(call('host.terminal.set', { allow: 'yes', confirm: true }, { home }), invalid(/allow must be/));
  await assert.rejects(lstat(file), 'nothing written without confirm');
  status = await call('host.terminal.set', { allow: true, confirm: true }, { home });
  assert.equal(status.allowRemoteTerminal, true);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  // The CLI reads the same file the same way.
  const lines = [];
  await terminalCommand(['status', '--json'], { home, out: line => lines.push(line) });
  assert.equal(JSON.parse(lines[0]).allowRemoteTerminal, true);
  status = await call('host.terminal.set', { allow: false }, { home });
  assert.equal(status.allowRemoteTerminal, false);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, allowRemoteTerminal: false });
});

test('host.usage.setting: on by default, off and back on in $ALP_HOME/usage.json, private; names this host', async t => {
  const { home } = await scratch(t);
  const file = path.join(home, 'usage.json');
  assert.deepEqual(await call('host.usage.setting.get', {}, { home }), { enabled: true, host: hostname() });
  await assert.rejects(call('host.usage.setting.set', { enabled: 'no' }, { home }), invalid(/enabled must be/));
  await assert.rejects(call('host.usage.setting.set', {}, { home }), invalid(/enabled must be/));
  await assert.rejects(lstat(file), 'nothing written for a bad value');
  assert.deepEqual(await call('host.usage.setting.set', { enabled: false }, { home }), { enabled: false, host: hostname() });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { enabled: false });
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await call('host.usage.setting.get', {}, { home }), { enabled: false, host: hostname() });
  assert.deepEqual(await call('host.usage.setting.set', { enabled: true }, { home }), { enabled: true, host: hostname() });
  // A file that is not the switch's JSON reads as the default, on.
  await writeFile(file, 'not json');
  assert.equal((await call('host.usage.setting.get', {}, { home })).enabled, true);
});

test('daemon.usage through the dashboard: forwarded with refresh and account while Check usage is on; off, answered disabled without asking alpd', async t => {
  const { home } = await scratch(t);
  const usage = { providers: [{ runtime: 'codex', available: true, windows: [] }] };
  let daemon = fakeDaemon({ 'daemon.usage': usage });
  assert.deepEqual(await call('daemon.usage', { refresh: true }, { home, daemon }), usage);
  assert.deepEqual(await call('daemon.usage', {}, { home, daemon }), usage);
  assert.deepEqual(daemon.calls, [['daemon.usage', { refresh: true, account: true }], ['daemon.usage', { account: true }]]);
  await call('host.usage.setting.set', { enabled: false }, { home });
  daemon = fakeDaemon({ 'daemon.usage': usage });
  assert.deepEqual(await call('daemon.usage', { refresh: true }, { home, daemon }), { disabled: true, providers: [] });
  assert.deepEqual(daemon.calls, [], 'no provider is asked while the switch is off');
});

const REGISTRY = {
  revision: 4,
  projects: [{ id: 'prj_a', root: '/p/a', canonical: '/p/a', addedAt: 't' }, { id: 'prj_gone', root: '/p/gone', addedAt: 't', removedAt: 't2' }],
  workspaces: [
    { id: 'wks_a', projectId: 'prj_a', directory: '/p/a', canonical: '/p/a', labels: ['Client'], createdAt: 't', title: null, pinnedAt: null, archivedAt: null },
    { id: 'wks_b', projectId: 'prj_a', directory: '/p/a-wt', labels: [], createdAt: 't', archivedAt: 't3', worktree: { id: 'x' } },
    { id: 'wks_gone', projectId: 'prj_gone', directory: '/p/gone', labels: [], createdAt: 't' },
  ],
  sessions: { s1: 'wks_a', s2: 'wks_a' },
  labels: { generation: 'g', seq: 1, catalog: [{ name: 'Client', color: 'sky' }] },
};

test('host.registry: live projects, their workspaces (archived too), labels; no canonical, receipts or session ids', async () => {
  const daemon = fakeDaemon({ 'registry.owner': { registry: REGISTRY } });
  const result = await call('host.registry', {}, { home: '/h', daemon });
  assert.deepEqual(daemon.calls, [['registry.owner', {}]]);
  assert.deepEqual(result, ownerRegistry(REGISTRY));
  assert.deepEqual(result.projects.map(project => project.id), ['prj_a']);
  assert.deepEqual(result.workspaces.map(workspace => [workspace.id, workspace.archivedAt, workspace.managedWorktree, workspace.sessions]), [['wks_a', null, false, 2], ['wks_b', 't3', true, 0]]);
  assert.deepEqual(result.labels, [{ name: 'Client', color: 'sky' }]);
  assert.ok(!JSON.stringify(result).includes('canonical'));
  assert.ok(!JSON.stringify(result).includes('s1'));
});

test('host.workspace.update archives through alpd workspace.update, without credential roots; requestIds are the owner\'s', async () => {
  const daemon = fakeDaemon({ 'workspace.update': { revision: 5 } });
  assert.deepEqual(await call('host.workspace.update', { workspaceId: 'wks_a', archived: true, ifRevision: 4, requestId: 'r1' }, { home: '/h', daemon }), { revision: 5 });
  assert.deepEqual(daemon.calls, [['workspace.update', { workspaceId: 'wks_a', archived: true, ifRevision: 4, requestId: 'dashboard-owner:r1' }]]);
  for (const params of [{ workspaceId: 'wks_a', ifRevision: 4, requestId: 'r' }, { workspaceId: 'wks_a', archived: 1, ifRevision: 4, requestId: 'r' }, { workspaceId: 'wks_a', archived: true, requestId: 'r' }, { workspaceId: 'wks_a', archived: true, ifRevision: 4 }, { archived: true, ifRevision: 4, requestId: 'r' }]) {
    await assert.rejects(call('host.workspace.update', params, { home: '/h', daemon }), error => error.code === -32602, JSON.stringify(params));
  }
  assert.equal(daemon.calls.length, 1);
});

test('host.workspace.label maps to registry.owner label operations only, never placement', async () => {
  const daemon = fakeDaemon({ 'registry.owner': { result: { workspaceLabels: ['Client'] }, registry: REGISTRY } });
  const run = params => call('host.workspace.label', { ifRevision: 4, requestId: 'r', ...params }, { home: '/h', daemon });
  const answer = await run({ action: 'assign', workspaceId: 'wks_a', name: '  New   label ', color: 'teal' });
  assert.deepEqual(answer.result, { workspaceLabels: ['Client'] });
  assert.deepEqual(answer.registry, ownerRegistry(REGISTRY));
  await run({ action: 'unassign', workspaceId: 'wks_a', name: 'Client' });
  await run({ action: 'update', name: 'Client', newName: 'Customer', color: 'red' });
  await run({ action: 'delete', name: 'Customer' });
  assert.deepEqual(daemon.calls.map(([method, params]) => [method, params.operation, params.args]), [
    ['registry.owner', 'label.assign', { workspaceId: 'wks_a', label: { name: 'New label', color: 'teal' }, assigned: true }],
    ['registry.owner', 'label.assign', { workspaceId: 'wks_a', label: { name: 'Client', color: 'violet' }, assigned: false }],
    ['registry.owner', 'label.update', { name: 'Client', newName: 'Customer', color: 'red' }],
    ['registry.owner', 'label.delete', { name: 'Customer' }],
  ]);
  for (const call of daemon.calls) assert.deepEqual([call[1].ifRevision, call[1].requestId], [4, 'dashboard-owner:r']);
  for (const params of [{ action: 'placement.assign', workspaceId: 'wks_a', name: 'x' }, { action: 'assign', workspaceId: 'wks_a', name: 'x', color: 'chartreuse' }, { action: 'assign', workspaceId: 'wks_a', name: '   ', color: 'sky' }, { action: 'update', name: 'x' }, { action: 'assign', name: 'x', color: 'sky' }]) {
    await assert.rejects(run(params), error => error.code === -32602, JSON.stringify(params));
  }
  assert.equal(daemon.calls.length, 4);
});

test('host.project.register checks the directory on the host (absolute, normalized, an existing directory) before alpd sees it', async t => {
  const { directory } = await scratch(t);
  const project = path.join(directory, 'project');
  await mkdir(project);
  const file = path.join(directory, 'file.txt');
  await writeFile(file, 'x');
  const link = path.join(directory, 'link');
  await symlink(project, link);
  const daemon = fakeDaemon({ 'project.register': { project: { id: 'prj_n' }, revision: 9 } });
  assert.deepEqual(await call('host.project.register', { directory: project, ifRevision: 8, requestId: 'r' }, { home: '/h', daemon }), { project: { id: 'prj_n' }, revision: 9 });
  assert.deepEqual(daemon.calls, [['project.register', { directory: project, ifRevision: 8, requestId: 'dashboard-owner:r' }]]);
  // A link to a directory is registered as given (alpd resolves its identity); a link to a file, or
  // to nothing, is not a directory.
  assert.equal(await projectDirectory(link), link);
  const fileLink = path.join(directory, 'file-link');
  await symlink(file, fileLink);
  await assert.rejects(projectDirectory(fileLink), invalid(/not a directory/));
  const dangling = path.join(directory, 'dangling');
  await symlink(path.join(directory, 'gone'), dangling);
  await assert.rejects(projectDirectory(dangling), invalid(/not a directory/));
  for (const [value, pattern] of [['relative/dir', /absolute/], [`${project}/../project`, /normalized/], [`${project}/`, /normalized/], [path.join(directory, 'missing'), /does not exist/], [file, /not a directory/], [42, /directory must be/]]) {
    await assert.rejects(call('host.project.register', { directory: value, ifRevision: 8, requestId: 'r' }, { home: '/h', daemon }), invalid(pattern), String(value));
  }
  assert.equal(daemon.calls.length, 1);
});

test('host.project.remove goes to alpd project.remove with the owner\'s requestId', async () => {
  const daemon = fakeDaemon({ 'project.remove': { project: { id: 'prj_a' }, revision: 6 } });
  await call('host.project.remove', { projectId: 'prj_a', ifRevision: 5, requestId: 'x' }, { home: '/h', daemon });
  assert.deepEqual(daemon.calls, [['project.remove', { projectId: 'prj_a', ifRevision: 5, requestId: 'dashboard-owner:x' }]]);
  await assert.rejects(call('host.project.remove', { ifRevision: 5, requestId: 'x' }, { home: '/h', daemon }), invalid(/projectId/));
});
