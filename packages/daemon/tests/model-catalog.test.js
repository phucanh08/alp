// The live model catalog over the wire (t-e5ee): catalog.get and library.models list a model only a
// provider reported, catalog.refresh asks again, and every helloed client hears catalog.updated. Mocked providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime, ModelCatalog } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { validateResult } from '@anhlp/alp-protocol/contract';

const transport = () => () => ({ async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {}, async request() { return {}; } });

async function setup(t, probes) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-catalog-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const runtime = createAlpRuntime({ transport: transport(), libraryDir: home });
  const modelCatalog = probes ? new ModelCatalog({ home, probes, refreshMs: 0 }) : undefined;
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', home, ...(modelCatalog ? { modelCatalog } : {}) });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); await new ModelCatalog({ probes: {} }).refresh(); });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = await connect(daemonPaths(directory).socket, { name: 'catalog-test', version: '0' });
  t.after(() => client.close());
  const call = async (method, params = {}) => {
    const result = await client.request(method, params);
    assert.deepEqual(validateResult(method, result), [], `${method} result: ${JSON.stringify(result)}`);
    return result;
  };
  return { client, call, modelCatalog };
}

test('catalog.refresh asks the providers; catalog.get and library.models list the live model; clients hear catalog.updated', async t => {
  let live = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low'] }];
  const { client, call } = await setup(t, { codex: async () => live, claude: async () => { throw new Error('not logged in'); } });
  const heard = [];
  client.onNotification((method, params) => heard.push({ method, params }));
  assert.ok(!(await call('catalog.get')).models.some(model => model.id === 'codex:gpt-6.1-terra'));
  live = [...live, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ['low', 'medium'] }];
  const refreshed = await call('catalog.refresh');
  assert.ok(refreshed.models.some(model => model.id === 'codex:gpt-6.1-terra'));
  assert.equal(refreshed.providers.codex.status, 'ok');
  assert.equal(refreshed.providers.claude.status, 'failed');
  assert.match(refreshed.providers.claude.error, /not logged in/);
  assert.ok(refreshed.models.some(model => model.id.startsWith('claude:')), 'static Claude rows still serve');
  assert.ok((await call('catalog.get')).models.some(model => model.id === 'codex:gpt-6.1-terra'));
  const { models } = await call('library.models');
  assert.deepEqual(models.find(model => model.id === 'codex:gpt-6.1-terra'), { id: 'codex:gpt-6.1-terra', label: 'codex · GPT-6.1 Terra', efforts: ['low', 'medium'] });
  for (let i = 0; i < 50 && !heard.some(n => n.method === 'catalog.updated'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(heard.some(n => n.method === 'catalog.updated' && typeof n.params.fetchedAt === 'string'));
});

test('without a live catalog, catalog.refresh is unavailable and catalog.get answers the static rows', async t => {
  const { client, call } = await setup(t);
  assert.ok((await call('catalog.get')).models.some(model => model.id === 'codex:gpt-6.1-sol'));
  await assert.rejects(client.request('catalog.refresh', {}), error => error.code === 1005);
});

// t-d0b0: ACP providers' rows come from their files; catalog.refresh and enabling a provider are the only probes.
test('ACP rows in catalog.get without a probe; catalog.refresh and enabling a provider probe it', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-acp-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'providers'), { recursive: true, mode: 0o700 });
  const { writeFile } = await import('node:fs/promises');
  const { listProviders } = await import('@anhlp/alp-core/providers');
  await writeFile(path.join(home, 'providers', 'opencode.json'), JSON.stringify({ kind: 'acp', label: 'OpenCode', command: 'opencode', args: ['acp'], enabled: true }));
  await writeFile(path.join(home, 'providers', 'later.json'), JSON.stringify({ kind: 'acp', label: 'Later', command: 'later', enabled: false }));
  const probed = [];
  const runtime = createAlpRuntime({ transport: transport(), libraryDir: home });
  const modelCatalog = new ModelCatalog({ home, probes: {}, refreshMs: 0, acpProviders: () => listProviders(home), acpProbe: async provider => { probed.push(provider.id); return [{ id: `${provider.id}-big`, label: 'Big' }]; } });
  await modelCatalog.start();
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', home, modelCatalog });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); modelCatalog.stop(); await new ModelCatalog({ probes: {} }).refresh(); });
  const client = await connect(daemonPaths(directory).socket, { name: 'catalog-test', version: '0' });
  t.after(() => client.close());
  const call = async (method, params = {}) => { const result = await client.request(method, params); assert.deepEqual(validateResult(method, result), [], method); return result; };

  const first = await call('catalog.get');
  assert.deepEqual(probed, [], 'nothing probed at start');
  assert.deepEqual(first.models.find(model => model.id === 'acp:opencode'), { id: 'acp:opencode', label: 'OpenCode · agent default', description: '', thinkingOptions: [], runtime: 'acp', provider: 'opencode', source: 'configured', enabled: true, status: 'unprobed' });
  assert.equal(first.models.find(model => model.id === 'acp:later').enabled, false);
  assert.deepEqual(first.providers['acp:opencode'], { status: 'unprobed' });

  const refreshed = await call('catalog.refresh');
  assert.deepEqual(probed, ['opencode'], 'catalog.refresh probes enabled providers only');
  assert.ok(refreshed.models.some(model => model.id === 'acp:opencode/opencode-big' && model.source === 'live'));
  assert.equal(refreshed.providers['acp:opencode'].status, 'ok');
  assert.ok((await call('library.models')).models.some(model => model.id === 'acp:opencode/opencode-big'), 'library.models lists learned models');

  // Saving a provider that is on already probes nothing; turning one on probes it.
  const get = name => call('library.get', { kind: 'providers', name, scope: 'library' });
  const opencode = await get('opencode');
  await call('library.save', { kind: 'providers', name: 'opencode', scope: 'library', content: { provider: { ...opencode.content.provider, label: 'OpenCode 2' } }, revision: opencode.revision });
  const later = await get('later');
  await call('library.save', { kind: 'providers', name: 'later', scope: 'library', content: { provider: { ...later.content.provider, enabled: true } }, revision: later.revision });
  for (let i = 0; i < 100 && !probed.includes('later'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(probed, ['opencode', 'later']);
  for (let i = 0; i < 100 && !(await call('catalog.get')).models.some(model => model.id === 'acp:later/later-big'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const after = await call('catalog.get');
  assert.ok(after.models.some(model => model.id === 'acp:later/later-big'));
  assert.equal(after.models.find(model => model.id === 'acp:opencode').label, 'OpenCode 2 · agent default');
});

test('production daemon catalog wiring isolates malformed providers, exposes errors and cleans disposable probe cwd', async t => {
  const { spawn } = await import('node:child_process');
  const { writeFile, readFile, stat } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-catalog-wiring-'));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'providers'), { recursive: true, mode: 0o700 });
  // chmod home itself: mkdir recursive's mode is subject to the parent creation sequence.
  const { chmod } = await import('node:fs/promises');
  await chmod(home, 0o700);
  const log = path.join(directory, 'acp.jsonl');
  const agyLog = path.join(directory, 'agy.jsonl');
  const agy = path.join(directory, 'agy.cjs');
  await writeFile(agy, `require('fs').appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(process.argv.slice(2))+'\\n'); console.log('configured-model\\tConfigured');`);
  const providerFile = path.join(home, 'providers/antigravity.json');
  const native = { kind: 'antigravity', command: process.execPath, args: [agy, 'configured-arg'], env: { FAKE_AGY_LOG: agyLog } };
  await writeFile(providerFile, JSON.stringify(native));
  await writeFile(path.join(home, 'providers/bad.json'), '{bad');
  await writeFile(path.join(home, 'providers/good.json'), JSON.stringify({ kind: 'acp', command: process.execPath,
    args: [fileURLToPath(new URL('../../../test/support/fake-acp.js', import.meta.url))], env: { FAKE_ACP_LOG: log, FAKE_ACP_MODELS: 'current' } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/alpd.js', import.meta.url))], {
    cwd: directory, env: { ...process.env, ALP_HOME: home, ALP_MODEL_CATALOG: 'live', ALP_CODEX_BIN: path.join(directory, 'missing-codex'), ALP_CLAUDE_BIN: path.join(directory, 'missing-claude') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true }); });
  let client;
  for (let i = 0; i < 500; i++) {
    try { client = await connect(daemonPaths(home).socket, { name: 'catalog-wiring', version: '0' }); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(client, output);
  t.after(() => client.close());
  let result = await client.request('catalog.refresh', {});
  assert.deepEqual(validateResult('catalog.refresh', result), []);
  assert.ok(result.models.some(row => row.id === 'acp:good/current'));
  assert.match(result.providers.acp.error, /bad.json/);
  assert.equal(result.providers.acp.status, 'failed');
  assert.ok(result.models.some(row => row.id === 'antigravity:configured-model'));
  const launches = (await readFile(agyLog, 'utf8')).trim().split('\n');
  assert.ok(launches.every(line => JSON.stringify(JSON.parse(line)) === JSON.stringify(['configured-arg', 'models'])));
  await writeFile(providerFile, JSON.stringify({ ...native, enabled: false }));
  await client.request('catalog.refresh', {});
  assert.equal((await readFile(agyLog, 'utf8')).trim().split('\n').length, launches.length, 'disabled native provider is never launched');
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const cwd = requests.filter(row => row.method === 'session/new').map(row => row.params.cwd);
  assert.ok(cwd.length >= 2);
  for (const dir of cwd) {
    assert.notEqual(dir, home);
    assert.match(path.basename(dir), /^alp-model-probe-/);
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  }
  await rm(path.join(home, 'providers/bad.json'));
  result = await client.request('catalog.refresh', {});
  assert.equal(result.providers.acp, undefined, 'fixed configuration clears the diagnostic');
});

test('production provider loader deduplicates unchanged errors and reports them again after recovery', async t => {
  const { createModelCatalog } = await import('../dist/model-catalog.js');
  const { writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-catalog-errors-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'providers'));
  const bad = path.join(home, 'providers/bad.json');
  await writeFile(bad, '{bad');
  const warnings = [];
  const catalog = createModelCatalog(home, message => warnings.push(message));
  await catalog.loadAcp(); await catalog.loadAcp();
  assert.equal(warnings.length, 1);
  assert.match(catalog.acpLoadError(), /bad.json/);
  await rm(bad); await catalog.loadAcp();
  assert.equal(catalog.acpLoadError(), undefined);
  await writeFile(bad, '{bad'); await catalog.loadAcp();
  assert.equal(warnings.length, 2);
});
