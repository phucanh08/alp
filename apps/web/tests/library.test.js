// Settings › the host's library (t-7679.14): library.get read only through the gateway, its secret
// markers shown as hidden, and the host labelled with its machine name from the hello (Paseo
// patches 0015, 0017). Against the in-memory host; no runtime is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, hostName } from '../src/lib/controller.js';
import { HIDDEN, isSecretMarker, libraryContentParts } from '../src/lib/library.js';
import { FakeHost, until } from './support/fake-host.js';

const MARK = { $secret: 'keep' };
/** An intercept that answers `result` in place of the fake host's default. */
const reply = result => (_params, _connection, { answer }) => { answer(typeof result === 'function' ? result() : result); return 'handled'; };

test('libraryContentParts: Markdown files as text, configuration as JSON with every marker hidden', () => {
  assert.deepEqual(libraryContentParts({ instructions: '# Writer', config: { model: 'm', skills: ['style'] } }), [
    { key: 'instructions', label: 'AGENT.md', kind: 'text', text: '# Writer' },
    { key: 'config', label: 'agent.json', kind: 'json', text: JSON.stringify({ model: 'm', skills: ['style'] }, null, 2) },
  ]);
  const [server] = libraryContentParts({ server: { command: 'npx', args: [MARK], env: { TOKEN: MARK }, url: MARK } });
  assert.equal(server.label, 'Server');
  assert.deepEqual(JSON.parse(server.text), { command: 'npx', args: [HIDDEN], env: { TOKEN: HIDDEN }, url: HIDDEN });
  assert.ok(!server.text.includes('$secret'));
  assert.deepEqual(libraryContentParts({ provider: MARK }), [{ key: 'provider', label: 'Provider', kind: 'json', text: HIDDEN }]);
  assert.equal(isSecretMarker({ $secret: 'keep', more: 1 }), false);
  assert.equal(isSecretMarker({ $secret: 'drop' }), false);
});

test('hostName: a trimmed machine name, nothing for anything else', () => {
  assert.equal(hostName(' studio.local '), 'studio.local');
  for (const value of [undefined, null, 7, '', '  ', 'a\u001bb', 'a\u202eb', 'a\u200bb', 'x'.repeat(254)]) assert.equal(hostName(value), undefined, JSON.stringify(value));
});

function setup(t, hello) {
  const host = new FakeHost();
  if (hello) host.intercept.set('daemon.hello', reply(hello));
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect());
  return { host, controller, state: () => controller.getState() };
}

async function connect({ controller, state }) {
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => state().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
}

test('the hello\'s hostname labels the host; without one there is none', async t => {
  const named = setup(t, { protocolVersion: 1, daemonVersion: '0.10.0', hostname: 'studio.local', capabilities: ['attach.after', 'prompt.receipts', 'task', 'team', 'library', 'settings.language'] });
  await connect(named);
  assert.equal(named.state().connection.hostname, 'studio.local');
  const unnamed = setup(t);
  await connect(unnamed);
  assert.equal(unnamed.state().connection.hostname, undefined);
});

test('getLibraryEntry reads library.get for the selected workspace and keeps its markers', async t => {
  const w = setup(t);
  const answer = { kind: 'mcp', name: 'vault', source: 'library', content: { server: { command: 'npx', env: { TOKEN: MARK } } }, revision: 'r1', usedBy: ['agent main', 7], secrets: ['/server/env/TOKEN'] };
  w.host.intercept.set('library.get', reply(answer));
  await connect(w);
  const entry = await w.controller.getLibraryEntry('mcp', 'vault');
  assert.deepEqual(w.host.calls.filter(call => call.method === 'library.get').map(call => call.params), [{ kind: 'mcp', name: 'vault', projectRoot: '/w/a' }]);
  assert.deepEqual(entry, { kind: 'mcp', name: 'vault', source: 'library', content: answer.content, revision: 'r1', usedBy: ['agent main'], secrets: ['/server/env/TOKEN'] });
  w.host.intercept.set('library.get', reply({ kind: 'mcp', name: 'vault', content: 'text' }));
  await assert.rejects(w.controller.getLibraryEntry('mcp', 'vault'), /does not read/);
});

test('getLibraryEntry asks nothing of the host without project.read', async t => {
  const host = new FakeHost({ principal: { id: 'p2', label: 'reader', permissions: ['session.read'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect());
  await connect({ controller, state: () => controller.getState() });
  await assert.rejects(controller.getLibraryEntry('agents', 'main'), /cannot read this workspace's configuration/);
  assert.equal(host.count('library.get'), 0);
});


test('project library editor requires its own permission and new daemon capability', async t => {
  const w = setup(t);
  await connect(w);
  await assert.rejects(w.controller.writeLibrary('save', 'skills', { name: 'notes', content: { body: 'text' } }), /library.write/);
  assert.equal(w.host.count('library.save'), 0);
  w.controller.disconnect();
  w.host.principal.permissions.push('library.write');
  await connect(w);
  await assert.rejects(w.controller.writeLibrary('save', 'skills', { name: 'notes', content: { body: 'text' } }), /Update the host/);
  w.controller.disconnect();
  w.host.capabilities.push('library.project.write');
  await connect(w);
  w.host.intercept.set('library.save', reply({ revision: 'new' }));
  const saved = await w.controller.writeLibrary('save', 'skills', { name: 'notes', content: { body: 'text' }, scope: 'library', projectRoot: '/other', revision: null });
  assert.equal(saved.revision, 'new');
  assert.deepEqual(w.host.calls.filter(c => c.method === 'library.save').at(-1).params, { name: 'notes', content: { body: 'text' }, scope: 'project', projectRoot: '/w/a', kind: 'skills', revision: null });
  await assert.rejects(w.controller.writeLibrary('save', 'hooks', { name: 'run' }), /administrative/);
});
