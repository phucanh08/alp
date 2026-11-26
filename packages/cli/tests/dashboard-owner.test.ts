// alp dashboard's host owner methods (t-a95b, src/dashboard/owner/): the host, library and workspace-facts tables are
// merged, a name in both stops the start, and each handler gets the gateway's context plus the ALP
// home and alpd's socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOwnerMethods, ownerMethods } from '../dist/dashboard/owner/index.js';
import { methods as host } from '../dist/dashboard/owner/host.js';
import { methods as library } from '../dist/dashboard/owner/library.js';
import { methods as workspaceFacts } from '../dist/dashboard/owner/workspace-facts.js';

test('owner methods: the host and library tables merge, and a name defined twice is refused', () => {
  const a = () => 'a';
  const b = () => 'b';
  assert.deepEqual(Object.keys(mergeOwnerMethods([{ 'x.one': a }, { 'x.two': b }])).sort(), ['x.one', 'x.two']);
  assert.throws(() => mergeOwnerMethods([{ 'x.one': a }, { 'x.one': b }]), /x\.one is defined twice/);
  // The shipped tables merge (a duplicate between groups B and C would stop the dashboard here).
  assert.deepEqual(Object.keys(ownerMethods({ home: '/h', socket: '/s' })).sort(), [...Object.keys(host), ...Object.keys(library), ...Object.keys(workspaceFacts)].sort());
});

test('owner methods: a handler gets the gateway context with home and socket added', async () => {
  const seen: unknown[] = [];
  (host as Record<string, (context: unknown) => unknown>)['test.owner.echo'] = context => { seen.push(context); return 'ok'; };
  try {
    const methods = ownerMethods({ home: '/alp/home', socket: '/alp/home/alpd.sock' });
    const daemon = { request: async () => undefined };
    assert.equal(await methods['test.owner.echo']({ method: 'test.owner.echo', params: { a: 1 }, principal: 'p', daemon }), 'ok');
    assert.deepEqual(seen, [{ method: 'test.owner.echo', params: { a: 1 }, principal: 'p', daemon, home: '/alp/home', socket: '/alp/home/alpd.sock' }]);
  } finally { delete (host as Record<string, unknown>)['test.owner.echo']; }
});
