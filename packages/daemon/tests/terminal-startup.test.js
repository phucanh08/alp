import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTerminalService } from '../dist/terminals.js';
const owner = { id: 'owner', epoch: 'e1' };
const params = requestId => ({ workspaceId: 'w', cols: 80, rows: 24, requestId });
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-native-start-'));
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true, limits: { maxPerPrincipal: 1 } }), { mode: 0o600 });
  const made = []; let release;
  const gate = new Promise(r => { release = r; });
  const service = createTerminalService({ home, resolveWorkspace: async () => home, sweepMs: 60000, log: { info() {}, warn() {} },
    spawn: async () => {
      const pty = { pid: 80001 + made.length, cleanups: 0, write() {}, resize() {}, kill() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, async cleanup() { this.cleanups++; return { observed: 1, live: 0, uncertain: 0 }; } };
      made.push(pty); await gate; return pty;
    } });
  let cleanupFailure = false;
  t.after(async () => { release(); if (cleanupFailure) await assert.rejects(service.shutdown(), e => e.data?.reason === 'terminal_cleanup_uncertain'); else await service.shutdown(); await rm(home, { recursive: true, force: true }); });
  const started = async () => { const until = Date.now() + 2000; while (!made.length && Date.now() < until) await new Promise(r => setTimeout(r, 5)); assert.equal(made.length, 1); };
  return { home, service, made, release, started, expectCleanupFailure() { cleanupFailure = true; } };
}
test('async startup reserves quota and shares requestId until native readiness', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('same'));
  await f.started();
  const repeated = f.service.create(owner, params('same'));
  await assert.rejects(f.service.create(owner, params('other')), e => e.data?.reason === 'terminal_limit');
  f.release();
  const [a, b] = await Promise.all([first, repeated]);
  assert.equal(a.terminal.terminalId, b.terminal.terminalId);
  assert.equal(f.made.length, 1);
});
test('revoke awaits startup cleanup and never publishes its late terminal', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('cancel'));
  const rejected = assert.rejects(first, e => e.data?.reason === 'terminal_revoked');
  await f.started();
  const revoking = f.service.revoke(owner.id);
  f.release();
  await rejected;
  assert.equal((await revoking).closed, 1);
  assert.equal(f.made[0].cleanups, 1);
  assert.deepEqual((await f.service.list(owner, {})).terminals, []);
});
test('host optout during startup cleans the late owner before refusal', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('off'));
  const rejected = assert.rejects(first, e => e.data?.reason === 'terminal_disabled');
  await f.started();
  await writeFile(path.join(f.home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: false }), { mode: 0o600 });
  f.release(); await rejected;
  assert.equal(f.made[0].cleanups, 1);
});
test('shutdown cancels pending readiness and waits for its owner cleanup', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('stop'));
  const rejected = assert.rejects(first, e => e.data?.reason === 'terminal_unsupported');
  await f.started(); const stopping = f.service.shutdown(); f.release();
  await rejected; await stopping;
  assert.equal(f.made[0].cleanups, 1);
});
test('uncertain native cleanup is a refusal and disables new terminal admission', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('uncertain'));
  await f.started(); f.made[0].cleanup = async () => ({ observed: 1, live: 0, uncertain: 1 });
  f.release(); const { terminal } = await first;
  await assert.rejects(f.service.close(owner, { terminalId: terminal.terminalId }), e => e.data?.reason === 'terminal_cleanup_uncertain');
  await assert.rejects(f.service.create(owner, params('later')), e => e.data?.reason === 'terminal_cleanup_uncertain');
  assert.equal(await f.service.advertised(), undefined);
  f.expectCleanupFailure();
});
test('a second concurrent revoke awaits already-cancelled startup without double counting', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('twice'));
  const rejected = assert.rejects(first, e => e.data?.reason === 'terminal_revoked');
  await f.started();
  const a = f.service.revoke(owner.id);
  let secondDone = false;
  const b = f.service.revoke(owner.id).then(result => { secondDone = true; return result; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(secondDone, false, 'every revoke must await the pending native owner');
  f.release(); await rejected;
  assert.equal((await a).closed, 1); assert.equal((await b).closed, 0);
  assert.equal(f.made[0].cleanups, 1);
});
test('both concurrent revokes refuse if their shared pending cleanup becomes uncertain', async t => {
  const f = await fixture(t);
  const first = f.service.create(owner, params('twice-uncertain'));
  const rejected = assert.rejects(first, e => e.data?.reason === 'terminal_cleanup_uncertain');
  await f.started();
  f.made[0].cleanup = async () => ({ observed: 1, live: 1, uncertain: 0 });
  const a = assert.rejects(f.service.revoke(owner.id), e => e.data?.reason === 'terminal_cleanup_uncertain');
  const b = assert.rejects(f.service.revoke(owner.id), e => e.data?.reason === 'terminal_cleanup_uncertain');
  f.release(); await Promise.all([rejected, a, b]);
  f.expectCleanupFailure();
});

test('root-only Linux opens without acknowledgment and discloses its protection', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-compat-warning-'));
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  let spawned = 0, cleaned = 0, spawnedProtection;
  const service = createTerminalService({ home, resolveWorkspace: async () => home, platform: 'linux',
    capability: () => ({ available: true, protection: 'root-only' }),
    spawn: (file, args, options) => { spawned++; spawnedProtection = options.protection; return { pid: 80001, write() {}, resize() {}, kill() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, async cleanup() { cleaned++; return { observed: 1, live: 0, uncertain: 0, coverage: 'root-only' }; } }; },
    log: { info() {}, warn() {} } });
  t.after(async () => { await service.shutdown(); await rm(home, { recursive: true, force: true }); });
  assert.ok(await service.advertised(), 'compatibility is functional, not hidden');
  const { terminal } = await service.create(owner, params('open'));
  assert.equal(spawned, 1, 'no acknowledgment is needed');
  assert.equal(spawnedProtection, 'root-only', 'the helper is started in root-only mode');
  assert.equal(terminal.protection, 'root-only', 'clients can disclose the limit');
  const sink = { send() {} };
  const attached = await service.attach(owner, sink, { terminalId: terminal.terminalId });
  assert.equal(attached.terminal.protection, 'root-only');
  const legacy = await service.create(owner, { ...params('legacy'), protectionAcknowledgment: 'linux-root-only-v1' });
  assert.equal(legacy.terminal.protection, 'root-only', 'the deprecated acknowledgment is accepted and ignored');
  await service.attach(owner, { send() {} }, { terminalId: legacy.terminal.terminalId, protectionAcknowledgment: 'linux-root-only-v1' });
  assert.equal((await service.list(owner, {})).terminals.every(entry => entry.protection === 'root-only'), true);
  await service.close(owner, { terminalId: terminal.terminalId });
  await service.close(owner, { terminalId: legacy.terminal.terminalId });
  assert.equal(cleaned, 2);
  assert.ok(await service.advertised(), 'known coverage limit is distinct from unexpected cleanup uncertainty');
});

test('a missing native helper still refuses on Linux (no plain-PTY fallback)', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-compat-missing-'));
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  let spawned = 0;
  const service = createTerminalService({ home, resolveWorkspace: async () => home, platform: 'linux',
    capability: () => ({ available: false, reason: 'native_prebuilt_unavailable' }),
    spawn: () => { spawned++; throw new Error('must not spawn'); }, log: { info() {}, warn() {} } });
  t.after(async () => { await service.shutdown(); await rm(home, { recursive: true, force: true }); });
  assert.equal(await service.advertised(), undefined);
  await assert.rejects(service.create(owner, params('missing')), e => e.data?.reason === 'terminal_unsupported');
  assert.equal(spawned, 0);
});

test('win32 terminals use the platform PTY with protection none and best-effort kill on close', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-win32-'));
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  let killed = 0, exit;
  const service = createTerminalService({ home, resolveWorkspace: async () => home, platform: 'win32',
    capability: () => ({ available: true, protection: 'none' }),
    // A node-pty-like owner: no native cleanup, so close kills the pty.
    spawn: (file, args, options) => { assert.equal(options.protection, 'none'); return { pid: 80002, write() {}, resize() {}, kill() { killed++; exit?.({ exitCode: 0 }); }, onData() { return { dispose() {} }; }, onExit(listener) { exit = listener; return { dispose() {} }; } }; },
    log: { info() {}, warn() {} } });
  t.after(async () => { await service.shutdown(); await rm(home, { recursive: true, force: true }); });
  assert.ok(await service.advertised(), 'win32 is served');
  const { terminal } = await service.create(owner, params('win'));
  assert.equal(terminal.protection, 'none');
  await service.close(owner, { terminalId: terminal.terminalId });
  assert.ok(killed >= 1, "close kills the pty");
});
