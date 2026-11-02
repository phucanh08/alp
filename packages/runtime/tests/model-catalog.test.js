// The live model catalog (t-e5ee): merge rules, cache, failure fallback, refresh, the per-turn feed,
// and that every in-process consumer (models, thinkingOptionsFor) reads the live rows. Mocked providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODELS, catalogModels } from '@anhlp/alp-core/models';
import { fitEffort, modelEfforts } from '@anhlp/alp-core/profiles';
import { ModelCatalog, acpSessionModels, catalogEntries, codexProbe, feedAcpSession, feedCatalog, liveFromContext, mergeCatalog, models, parseAgyModels, setActiveCatalog, thinkingOptionsFor } from '@anhlp/alp-runtime';

const home = async t => { const directory = await mkdtemp(path.join(tmpdir(), 'alp-catalog-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };
// Each test leaves the process-wide catalog static again.
const reset = t => t.after(() => new ModelCatalog({ probes: {} }).refresh());
const codexLive = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], effort: 'low' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], effort: 'low' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', description: 'Balanced.', efforts: ['low', 'medium', 'high'], effort: 'medium' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: ['low', 'medium'], effort: 'medium' },
];

test('merge: live order, labels and new models win; static rows stay as fallback; ALP policy last', () => {
  const merged = mergeCatalog(MODELS, { codex: codexLive });
  const codex = merged.filter(entry => entry.runtime === 'codex');
  assert.deepEqual(codex.slice(0, 4).map(entry => entry.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol']);
  assert.ok(codex.slice(0, 4).every(entry => entry.source === 'live'));
  const terra = codex.find(entry => entry.id === 'gpt-6.1-terra');
  assert.deepEqual(terra, { runtime: 'codex', id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', description: 'Balanced.', efforts: ['low', 'medium', 'high'], effort: 'medium', source: 'live' });
  // A known model keeps ALP's default effort; the provider's new efforts are added after ALP's.
  assert.equal(codex.find(entry => entry.id === 'gpt-6-sol').effort, 'low');
  // Policy: Astra stays low-only whatever Codex offers.
  assert.deepEqual(codex.find(entry => entry.id === 'gpt-6-astra').efforts, ['low']);
  // Static rows Codex did not report are kept as fallback.
  assert.equal(codex.find(entry => entry.id === 'gpt-5.6-sol').source, 'fallback');
  // Runtimes without a live list keep their static rows untouched.
  assert.deepEqual(merged.filter(entry => entry.runtime === 'claude'), MODELS.filter(entry => entry.runtime === 'claude'));
  // Empty or malformed answers change nothing.
  assert.deepEqual(mergeCatalog(MODELS, { codex: [], claude: [{ id: '' }] }), MODELS);
});

test('refresh applies the live list to every consumer, caches it atomically, and emits updated', async t => {
  reset(t);
  const directory = await home(t);
  const catalog = new ModelCatalog({ home: directory, probes: { codex: async () => codexLive } });
  const updates = [];
  catalog.onUpdated((snapshot, rows) => updates.push({ snapshot, rows }));
  await catalog.refresh();
  assert.equal(updates.length, 1);
  assert.equal(catalog.state().providers.codex.status, 'ok');
  assert.ok(models.some(model => model.id === 'codex:gpt-6.1-terra'), 'runtime models');
  assert.ok(catalogEntries.some(entry => entry.id === 'gpt-6.1-terra'), 'catalog entries');
  assert.deepEqual(thinkingOptionsFor('codex', 'gpt-6.1-terra').map(option => option.id), ['low', 'medium', 'high']);
  const cached = JSON.parse(await readFile(path.join(directory, 'cache', 'models.json'), 'utf8'));
  assert.deepEqual(cached.providers.codex.models, codexLive);
  // Readers outside alpd (alp setup, Paseo) merge the same cache.
  assert.ok(catalogModels(directory).some(entry => entry.id === 'gpt-6.1-terra'));
  assert.deepEqual(catalogModels(path.join(directory, 'missing')), MODELS);
  // A new catalog starts from the cache before any provider answers.
  const next = new ModelCatalog({ home: directory, probes: {}, refreshMs: 0, apply: false });
  await next.load();
  assert.ok(next.entries().some(entry => entry.id === 'gpt-6.1-terra'));
});

test('a failed, slow or empty probe keeps the previous list and records why', async t => {
  reset(t);
  let mode = 'ok';
  const catalog = new ModelCatalog({ timeoutMs: 50, probes: { codex: async () => {
    if (mode === 'fail') throw new Error('not logged in');
    if (mode === 'slow') return new Promise(() => {});
    if (mode === 'empty') return [];
    return codexLive;
  } } });
  await catalog.refresh();
  for (const failure of ['fail', 'slow', 'empty']) {
    mode = failure;
    await catalog.refresh();
    assert.equal(catalog.state().providers.codex.status, 'failed', failure);
    assert.ok(catalog.state().providers.codex.error, failure);
    assert.ok(catalog.entries().some(entry => entry.id === 'gpt-6.1-terra'), failure);
  }
  // One provider failing does not stop another.
  const mixed = new ModelCatalog({ apply: false, probes: { codex: async () => { throw new Error('down'); }, claude: async () => [{ id: 'claude-new-1', label: 'New' }] } });
  await mixed.refresh();
  assert.equal(mixed.state().providers.codex.status, 'failed');
  assert.ok(mixed.entries().some(entry => entry.runtime === 'claude' && entry.id === 'claude-new-1'));
  assert.ok(mixed.entries().some(entry => entry.runtime === 'codex' && entry.id === 'gpt-6.1-sol'), 'static codex rows serve');
});

test('concurrent refreshes share one probe run', async t => {
  reset(t);
  let calls = 0;
  const catalog = new ModelCatalog({ apply: false, refreshMs: 0, probes: { codex: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return codexLive; } } });
  await Promise.all([catalog.refresh(), catalog.refresh()]);
  assert.equal(calls, 1);
  t.after(() => catalog.stop());
});

test('each turn\'s orchestration context feeds the active catalog', async t => {
  reset(t);
  const catalog = new ModelCatalog({ probes: {} });
  setActiveCatalog(catalog);
  t.after(() => setActiveCatalog(undefined));
  const context = { runtime: 'codex', catalogAvailable: true, catalogComplete: true, models: [{ id: 'codex:gpt-turn-new', label: 'Turn New', thinking: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };
  assert.deepEqual(liveFromContext(context), { runtime: 'codex', models: [{ id: 'gpt-turn-new', label: 'Turn New', description: undefined, efforts: ['low', 'high'] }] });
  assert.equal(liveFromContext({ ...context, catalogComplete: false }), undefined);
  assert.equal(liveFromContext({ runtime: 'acp', catalogAvailable: true, models: [] }), undefined);
  const updated = new Promise(resolve => catalog.onUpdated(resolve));
  feedCatalog(context);
  await updated;
  assert.ok(models.some(model => model.id === 'codex:gpt-turn-new'));
  // The same list again changes nothing.
  assert.equal(await catalog.ingest('codex', liveFromContext(context).models), false);
});

test('a turn\'s list only adds models: it never narrows or reshapes what a probe answered', async t => {
  reset(t);
  const catalog = new ModelCatalog({ apply: false, probes: { codex: async () => codexLive } });
  await catalog.refresh();
  const before = catalog.state().providers.codex.models;
  assert.equal(await catalog.ingest('codex', [{ id: 'gpt-6.1-terra', label: 'Other' }]), false);
  assert.deepEqual(catalog.state().providers.codex.models, before);
  assert.equal(catalog.entries().find(entry => entry.id === 'gpt-6.1-terra').effort, 'medium');
  assert.equal(await catalog.ingest('codex', [{ id: 'gpt-7' }]), true);
  assert.deepEqual(catalog.state().providers.codex.models.map(model => model.id), [...codexLive.map(model => model.id), 'gpt-7']);
});

test('a corrupt cache never stops the catalog: static rows serve and the next refresh works', async t => {
  reset(t);
  const directory = await home(t);
  await mkdir(path.join(directory, 'cache'), { recursive: true });
  for (const body of ['{not json', JSON.stringify({ providers: { codex: { status: 'ok', models: { a: 1 } }, claude: { models: [{ id: 5 }, { id: 'x', label: { a: 1 }, efforts: 'low' }] }, bogus: { models: [] } } })]) {
    await writeFile(path.join(directory, 'cache', 'models.json'), body);
    const catalog = new ModelCatalog({ home: directory, apply: false, probes: { codex: async () => codexLive } });
    await catalog.load();
    assert.ok(catalog.entries().some(entry => entry.id === 'gpt-6.1-sol'));
    const claudeX = catalog.entries().find(entry => entry.runtime === 'claude' && entry.id === 'x');
    if (claudeX) assert.equal(claudeX.label, 'x');
    await catalog.refresh();
    assert.ok(catalog.entries().some(entry => entry.id === 'gpt-6.1-terra'));
  }
});

test('a probe past its bound is aborted', async t => {
  reset(t);
  let aborted = false;
  const catalog = new ModelCatalog({ apply: false, timeoutMs: 30, probes: { claude: signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) } });
  await catalog.refresh();
  assert.equal(aborted, true);
  assert.equal(catalog.state().providers.claude.status, 'failed');
});

test('agy models output parses id<TAB>label lines', () => {
  assert.deepEqual(parseAgyModels('gemini-4-pro\tGemini 4 Pro\n\nbare-id\n  \n'), [{ id: 'gemini-4-pro', label: 'Gemini 4 Pro' }, { id: 'bare-id', label: 'bare-id' }]);
});

test('the Codex probe asks app-server model/list, pages, and skips hidden models', { skip: process.platform === 'win32' }, async t => {
  const directory = await home(t);
  const fake = path.join(directory, 'fake-codex.mjs');
  await writeFile(fake, `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'model/list') send({ id: message.id, result: message.params.cursor
    ? { data: [{ model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', description: 'd', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }], nextCursor: null }
    : { data: [{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { model: 'secret', hidden: true }], nextCursor: 'p2' } });
});
`);
  await chmod(fake, 0o755);
  const result = await codexProbe(fake)(new AbortController().signal);
  assert.deepEqual(result.map(model => model.id), ['gpt-6.1-sol', 'gpt-6.1-terra']);
  assert.deepEqual(result[1].efforts, ['low']);
});

test('core effort checks follow the live catalog the daemon applied (t-086c)', async t => {
  reset(t);
  assert.equal(modelEfforts('codex:gpt-live-core'), undefined);
  await new ModelCatalog({ probes: { codex: async () => [{ id: 'gpt-live-core', efforts: ['low', 'high', 'warp'], effort: 'high' }] }, refreshMs: 0 }).refresh();
  assert.deepEqual(modelEfforts('codex:gpt-live-core'), ['low', 'high']);
  assert.equal(fitEffort('codex:gpt-live-core', 'max'), 'high');
});

// ACP providers in the catalog (t-d0b0): rows from providers/<id>.json, models learned from session/new,
// a probe only on an explicit refreshAcp (catalog.refresh, or the user enabling a provider).
const acpConfigs = [
  { id: 'opencode', kind: 'acp', label: 'OpenCode', enabled: true },
  { id: 'gemini', kind: 'acp', label: 'Gemini', models: [{ id: 'gemini-pro', label: 'Pro' }], additionalModels: [{ id: 'gemini-flash' }] },
  { id: 'off', kind: 'acp', label: 'Off', enabled: false },
  { id: 'antigravity', kind: 'antigravity', label: 'Antigravity' },
];

test('ACP: start lists configured providers as unprobed rows and starts none of them', async t => {
  reset(t);
  const probed = [];
  const catalog = new ModelCatalog({ home: await home(t), probes: {}, refreshMs: 0, acpProviders: async () => acpConfigs, acpProbe: async provider => { probed.push(provider.id); return []; } });
  await catalog.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(probed, [], 'no ACP probe at start');
  const rows = catalog.acpRows();
  assert.deepEqual(rows.map(row => row.id), ['opencode', 'gemini', 'gemini/gemini-pro', 'gemini/gemini-flash', 'off']);
  assert.deepEqual(rows[0], { runtime: 'acp', provider: 'opencode', id: 'opencode', label: 'OpenCode · agent default', description: '', efforts: [], source: 'configured', enabled: true, status: 'unprobed' });
  assert.equal(rows.find(row => row.id === 'gemini/gemini-pro').source, 'configured');
  assert.equal(rows.find(row => row.id === 'off').enabled, false);
  assert.ok(!rows.some(row => row.provider === 'antigravity'), 'Antigravity keeps its own runtime rows');
  catalog.stop();
});

test('ACP: a session/new answer teaches the active catalog the provider\'s models, additively', async t => {
  reset(t);
  const directory = await home(t);
  const catalog = new ModelCatalog({ home: directory, probes: {}, refreshMs: 0, acpProviders: async () => acpConfigs });
  await catalog.loadAcp();
  const updates = [];
  catalog.onUpdated(snapshot => updates.push(snapshot));
  setActiveCatalog(catalog);
  t.after(() => setActiveCatalog(undefined));
  assert.deepEqual(acpSessionModels({ configOptions: [{ category: 'model', type: 'select', options: [{ value: 'small', name: 'Small' }, { options: [{ value: 'large' }] }] }] }), [{ id: 'small', label: 'Small' }, { id: 'large' }]);
  feedAcpSession('opencode', { sessionId: 's', models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'Model A' }, { modelId: 'b' }, { name: 'no id' }] } });
  for (let i = 0; i < 50 && !updates.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.length, 1);
  assert.deepEqual(catalog.acpRows().filter(row => row.provider === 'opencode').map(row => [row.id, row.label, row.source, row.status]),
    [['opencode', 'OpenCode · agent default', 'configured', 'ok'], ['opencode/a', 'OpenCode · Model A', 'live', 'ok'], ['opencode/b', 'OpenCode · b', 'live', 'ok']]);
  // Nothing new changes nothing; a provider whose file lists models keeps the file's list.
  assert.equal(await catalog.learnAcp('opencode', [{ id: 'a' }]), false);
  await catalog.learnAcp('gemini', [{ id: 'other' }]);
  assert.ok(!catalog.acpRows().some(row => row.id === 'gemini/other'));
  // What was learned is cached for the next start.
  const next = new ModelCatalog({ home: directory, probes: {}, refreshMs: 0, apply: false, acpProviders: async () => acpConfigs });
  await next.load(); await next.loadAcp();
  assert.ok(next.acpRows().some(row => row.id === 'opencode/b'));
});

test('ACP: refreshAcp probes enabled providers only (or the named one), and a failure keeps what was known', async t => {
  reset(t);
  const probed = [];
  let fail = false;
  const catalog = new ModelCatalog({ probes: {}, refreshMs: 0, timeoutMs: 50, acpProviders: async () => acpConfigs, acpProbe: async provider => {
    probed.push(provider.id);
    if (fail) throw new Error('needs login');
    return [{ id: `${provider.id}-m1`, label: 'M1' }];
  } });
  await catalog.refreshAcp();
  assert.deepEqual(probed.sort(), ['gemini', 'opencode'], 'disabled and Antigravity providers are not started');
  assert.ok(catalog.acpRows().some(row => row.id === 'opencode/opencode-m1' && row.source === 'live' && row.status === 'ok'));
  probed.length = 0;
  fail = true;
  await catalog.refreshAcp(['opencode']);
  assert.deepEqual(probed, ['opencode']);
  assert.equal(catalog.state().acp.opencode.status, 'failed');
  assert.match(catalog.state().acp.opencode.error, /needs login/);
  assert.ok(catalog.acpRows().some(row => row.id === 'opencode/opencode-m1'), 'the previous list stays');
});

test('ACP: a failing provider listing keeps the known rows and records why, and refreshAcp still resolves', async t => {
  reset(t);
  let fail = false;
  const catalog = new ModelCatalog({ probes: {}, refreshMs: 0, acpProviders: async () => { if (fail) throw new Error('providers/bad.json: Unexpected token'); return acpConfigs; }, acpProbe: async () => [] });
  await catalog.loadAcp();
  const before = catalog.acpRows().length;
  assert.ok(before > 0);
  fail = true;
  await catalog.refreshAcp();
  assert.equal(catalog.acpRows().length, before, 'the previous ACP rows stay');
  assert.match(catalog.acpLoadError(), /bad\.json/);
  fail = false;
  await catalog.loadAcp();
  assert.equal(catalog.acpLoadError(), undefined);
});

test('ACP: a model learnAcp adds while a probe runs is kept (success unions, failure keeps current)', async t => {
  reset(t);
  let catalog;
  catalog = new ModelCatalog({ probes: {}, refreshMs: 0, timeoutMs: 1000, acpProviders: async () => acpConfigs, acpProbe: async provider => {
    await catalog.learnAcp(provider.id, [{ id: `${provider.id}-learned` }]);
    return [{ id: `${provider.id}-probed` }];
  } });
  await catalog.refreshAcp(['opencode']);
  assert.deepEqual(catalog.acpModels('opencode').map(model => model.id).sort(), ['opencode-learned', 'opencode-probed']);
  const late = new ModelCatalog({ probes: {}, refreshMs: 0, timeoutMs: 1000, acpProviders: async () => acpConfigs, acpProbe: async provider => {
    await late.learnAcp(provider.id, [{ id: 'mid' }]); throw new Error('down');
  } });
  await late.refreshAcp(['gemini']);
  assert.equal(late.state().acp.gemini.status, 'failed');
  assert.ok(late.acpModels('gemini').some(model => model.id === 'mid'));
});
