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

// t-7679.11: prompt images reach Claude and ACP agents as their own inline image blocks, never a path or URL.
test('turn-input images map to Claude and ACP image blocks; other URLs are refused or dropped', async () => {
  const { claudeContent } = await import('@anhlp/alp-runtime/claude-transport');
  const { acpContent } = await import('@anhlp/alp-runtime/acp-transport');
  const image = { type: 'image', url: 'data:image/webp;base64,UklGRg==' };
  assert.deepEqual(claudeContent({ type: 'text', text: 'hi' }), { type: 'text', text: 'hi' });
  assert.deepEqual(claudeContent(image), { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } });
  assert.throws(() => claudeContent({ type: 'image', url: 'file:///etc/passwd' }), /inline base64/);
  assert.throws(() => claudeContent({ type: 'image', url: 'data:image/svg+xml;base64,PHN2Zz4=' }), /inline base64/);
  assert.deepEqual(acpContent(image), { type: 'image', mimeType: 'image/webp', data: 'UklGRg==' });
  assert.equal(acpContent({ type: 'image', url: 'https://example.invalid/a.png' }), null);
  assert.equal(acpContent({ type: 'localImage', path: '/etc/passwd' }), null);
});
