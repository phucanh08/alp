import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, createProviderRegistry, ProviderRegistry } from '@anhlp/alp-runtime/providers';

test('provider adapters are extensible per instance and preserve legacy factory precedence', () => {
  const native = createProviderRegistry();
  assert.deepEqual(native.list(), ['codex', 'claude', 'acp', 'antigravity']);
  const transport = { adapter: 'fake' };
  let received;
  const registry = createProviderRegistry({ claude: context => { received = context; return transport; } });
  const environment = { CUSTOM: 'yes' };
  assert.equal(createTransport({ providerRegistry: registry }, 'claude', '/tmp/project', environment), transport);
  assert.equal(received.cwd, '/tmp/project');
  assert.equal(received.environment, environment);
  assert.equal(received.runtime, 'claude');
  const custom = new ProviderRegistry({ 'acp:custom': () => transport });
  assert.equal(createTransport({ providerRegistry: custom }, 'acp', '/tmp/project', {}, { id: 'custom' }), transport);
  const legacy = { adapter: 'legacy' };
  let args;
  assert.equal(createTransport({ providerRegistry: registry, transport: (...passed) => { args = passed; return legacy; } }, 'claude', '/tmp/project', environment), legacy);
  assert.deepEqual(args, ['/tmp/project', environment, 'claude', undefined, undefined]);
  assert.throws(() => custom.register('', () => transport), /needs an id/);
  assert.throws(() => custom.create('missing', {}), /Unknown runtime provider/);
});
