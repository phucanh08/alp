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
