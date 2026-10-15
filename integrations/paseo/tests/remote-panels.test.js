// The remote mode's catalog and settings answers that need no alpd (docs/alp/paseo-remote.md §4):
// the provider's catalog without a folder, and the read-only library list and language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteProvider, registerRemoteLibraryRpc } from 'alp-paseo-plugin/remote';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';

const principal = { id: 'c1', permissions: ['session.read', 'session.write', 'project.read'], workspaces: ['/w'], workspaceRoots: [{ path: '/w', canonical: '/w' }] };

function fakeClient() {
  const requests = [];
  return {
    requests,
    closed: false,
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'team.list') return { teams: [{ id: 'pho', label: 'Phở' }, { id: 'night', label: 'Night shift' }] };
      if (method === 'library.models') return { models: [] };
      if (method === 'library.list') return { entries: [{ name: 'main', source: 'builtin' }] };
      if (method === 'settings.language.get') return { language: null, applies: 'Vietnamese', default: 'Vietnamese' };
      return {};
    },
    onEvent() { return () => {}; },
    onClose() { return () => {}; },
    close() {},
  };
}

test('the catalog without a folder offers the built-in teams, reads nothing from alpd and opens nothing', async () => {
  const client = fakeClient();
  const registration = createRemoteProvider({ url: 'http://127.0.0.1:1', token: 'alpgw1.x.y' }, { open: async () => ({ client, principal, capabilities: ['attach.after', 'prompt.receipts'] }) });
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [];
  connection.onEvent(event => events.push(event));
  await connection.send({ type: 'catalog', requestId: 'global' });
  const global = events.find(event => event.type === 'catalog' && event.requestId === 'global');
  assert.ok(global, JSON.stringify(events));
  assert.deepEqual(global.catalog.models.map(model => model.id), ['pho', 'cafe']);
  assert.ok(!client.requests.some(request => request.method === 'team.list'), 'no workspace is chosen for it');
  // A granted folder lists that workspace's teams; another folder is refused as before.
  await connection.send({ type: 'catalog', requestId: 'here', cwd: '/w' });
  assert.deepEqual(events.find(event => event.requestId === 'here' && event.type === 'catalog').catalog.models.map(model => model.id), ['pho', 'night']);
  assert.deepEqual(client.requests.find(request => request.method === 'team.list').params, { projectRoot: '/w' });
  await connection.send({ type: 'catalog', requestId: 'elsewhere', cwd: '/other' });
  assert.match(events.find(event => event.requestId === 'elsewhere').error.message, /not a workspace your ALP credential grants/);
  await connection.close();
});

test('the library list and language say they are read-only; with no workspace, why nothing is listed', async () => {
  const client = fakeClient();
  const handlers = new Map();
  const server = { handle(contract, handler) { handlers.set(contract.name, { contract, handler }); } };
  registerRemoteLibraryRpc(server, { request: (method, params) => client.request(method, params), principal: async () => principal });
  const call = async (name, input) => { const { contract, handler } = handlers.get(name); return contract.output.parse(await handler(contract.input.parse(input))); };
  const listed = await call('alp.library.list', { directory: '/w', kind: 'agents' });
  assert.deepEqual(listed.entries.map(entry => entry.name), ['main']);
  assert.match(listed.readOnly.reason, /not opened or changed/);
  assert.equal(listed.readOnly.unlisted, undefined);
  const none = await call('alp.library.list', { kind: 'agents' });
  assert.deepEqual(none.entries, []);
  assert.match(none.readOnly.unlisted, /Open a workspace your ALP credential grants/);
  assert.equal(client.requests.filter(request => request.method === 'library.list').length, 1, 'nothing asked of alpd without a workspace');
  const language = await call('alp.settings.language.get', {});
  assert.equal(language.applies, 'Vietnamese');
  assert.match(language.readOnly, /Unavailable in ALP remote mode/);
});
