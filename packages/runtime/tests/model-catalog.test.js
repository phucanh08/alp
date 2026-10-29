// The live model catalog (t-e5ee): merge rules, cache, failure fallback, refresh, the per-turn feed,
// and that every in-process consumer (models, thinkingOptionsFor) reads the live rows. Mocked providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODELS, catalogModels } from '@anhlp/alp-core/models';
import { ModelCatalog, catalogEntries, codexProbe, feedCatalog, liveFromContext, mergeCatalog, models, parseAgyModels, setActiveCatalog, thinkingOptionsFor } from '@anhlp/alp-runtime';

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
