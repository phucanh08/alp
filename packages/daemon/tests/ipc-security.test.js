import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, lstat, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { connect } from '@anhlp/alp-client';
import { fakeTransport } from '../../../test/support/fake-agent.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-ipc-'));
  const socketPath = path.join(directory, 'alpd.sock');
  const runtime = createAlpRuntime({ transport: fakeTransport([]), supervisor: false, libraryDir: directory });
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  t.after(async () => { await server.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { directory, socketPath, runtime, server };
}

test('security: IPC refuses non-sockets before unlink and unsafe parents before listen', { skip: process.platform === 'win32' }, async t => {
  const { directory, socketPath, server } = await fixture(t);
  await writeFile(socketPath, 'keep me');
  await assert.rejects(server.listen(), /socket|IPC/i);
  assert.equal(await readFile(socketPath, 'utf8'), 'keep me');
  await unlink(socketPath);
  await chmod(directory, 0o777);
  await assert.rejects(server.listen(), /private|permission|IPC/i);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
  await chmod(directory, 0o700);
  const target = path.join(directory, 'target');
  await writeFile(target, 'target');
  await symlink(target, socketPath);
  await assert.rejects(server.listen(), /socket|IPC/i);
  assert.equal((await lstat(socketPath)).isSymbolicLink(), true);
});

test('security: IPC preserves live endpoint and replacement file on close', { skip: process.platform === 'win32' }, async t => {
  const { socketPath, runtime, server } = await fixture(t);
  await server.listen();
  const second = createDaemonServer({ runtime, socketPath, version: 'test' });
  t.after(() => second.close());
  await assert.rejects(second.listen(), /running|use|active/i);
  const client = await connect(socketPath);
  assert.ok((await client.request('daemon.status')).pid);
  client.close();
  await unlink(socketPath);
  await writeFile(socketPath, 'replacement');
  await second.close();
  await server.close();
  assert.equal(await readFile(socketPath, 'utf8'), 'replacement');
});

test('security: client rejects public socket before handshake', { skip: process.platform === 'win32' }, async t => {
  const { socketPath, server } = await fixture(t);
  await server.listen();
  await chmod(socketPath, 0o666);
  await assert.rejects(connect(socketPath), /private|permission|IPC/i);
});

test('security: writable non-sticky ancestor is refused before creating socket directory', { skip: process.platform === 'win32' }, async t => {
  const { directory, runtime } = await fixture(t);
  const child = path.join(directory, 'new-private');
  const server = createDaemonServer({ runtime, socketPath: path.join(child, 'rpc.sock'), version: 'test' });
  t.after(() => server.close());
  await chmod(directory, 0o777);
  await assert.rejects(server.listen(), /private|permission|IPC/i);
  await assert.rejects(lstat(child), { code: 'ENOENT' });
});

test('security: a link cannot hide an attacker-writable lexical ancestor', { skip: process.platform === 'win32' }, async t => {
  const { directory, runtime } = await fixture(t);
  const other = await mkdtemp(path.join(tmpdir(), 'alp-ipc-link-'));
  await symlink(directory, path.join(other, 'link'));
  await chmod(other, 0o777);
  const server = createDaemonServer({ runtime, socketPath: path.join(other, 'link', 'rpc.sock'), version: 'test' });
  t.after(() => server.close());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(other, { recursive: true, force: true }));
  await assert.rejects(server.listen(), /IPC|permission/i);
  await assert.rejects(lstat(path.join(directory, 'rpc.sock')), { code: 'ENOENT' });
});

test('security: every intermediate symlink target parent must be trusted', { skip: process.platform === 'win32' }, async t => {
  const { directory, runtime } = await fixture(t);
  const unsafe = await mkdtemp(path.join(tmpdir(), 'alp-ipc-chain-'));
  await symlink(directory, path.join(unsafe, 'second'));
  await symlink(path.join(unsafe, 'second'), path.join(directory, 'first'));
  await chmod(unsafe, 0o777);
  const server = createDaemonServer({ runtime, socketPath: path.join(directory, 'first', 'new', 'rpc.sock'), version: 'test' });
  t.after(() => server.close());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(unsafe, { recursive: true, force: true }));
  await assert.rejects(server.listen(), /IPC|permission/i);
  await assert.rejects(lstat(path.join(directory, 'new')), { code: 'ENOENT' });
});

// Windows: named-pipe access is an ACL, not mode bits. Read the live DACL through .NET Framework.
const pipeName = () => `alp-test-${randomBytes(6).toString('hex')}`;
const BROAD = new Set(['S-1-1-0', 'S-1-5-2', 'S-1-5-4', 'S-1-5-7', 'S-1-5-11', 'S-1-5-32-545']);
// WriteData | CreateNewInstance | Delete | ChangePermissions | TakeOwnership
const WRITE_LIKE = 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000;

test('security: Windows daemon pipe grants no other user write or instance rights', { skip: process.platform !== 'win32' }, async t => {
  const name = pipeName();
  const runtime = createAlpRuntime({ transport: fakeTransport([]), supervisor: false });
  const server = createDaemonServer({ runtime, socketPath: `\\\\.\\pipe\\${name}`, version: 'test' });
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  await server.listen();
  const script = [
    `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::InOut)`,
    '$c.Connect(5000)',
    '"USER|" + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$c.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { "ACE|" + $_.IdentityReference.Value + "|" + $_.AccessControlType + "|" + [int]$_.PipeAccessRights }',
    '$c.Dispose()',
  ].join('; ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  t.diagnostic(output.trim().replace(/\r?\n/g, ' ; '));
  const user = output.match(/^USER\|(\S+)/m)?.[1];
  assert.ok(user, output);
  const aces = [...output.matchAll(/^ACE\|([^|]+)\|(\w+)\|(\d+)/gm)].map(([, sid, type, rights]) => ({ sid, type, rights: Number(rights) }));
  assert.ok(aces.length, output);
  const trusted = sid => sid === user || sid === 'S-1-5-18' || sid === 'S-1-5-32-544' || sid.startsWith('S-1-5-5-') || sid === 'S-1-3-4';
  for (const ace of aces.filter(ace => ace.type === 'Allow')) {
    assert.ok(!BROAD.has(ace.sid) || (ace.rights & WRITE_LIKE) === 0, `broad principal ${ace.sid} has write-like rights ${ace.rights}`);
    assert.ok(trusted(ace.sid) || (ace.rights & WRITE_LIKE) === 0, `untrusted principal ${ace.sid} has write-like rights ${ace.rights}`);
  }
});

// Node cannot narrow the default pipe DACL, which grants Everyone and Anonymous read.
// A read-only handle cannot send daemon.hello, so the daemon never writes anything to it.
test('security: Windows read-only pipe client receives no daemon data', { skip: process.platform !== 'win32' }, async t => {
  const name = pipeName();
  const runtime = createAlpRuntime({ transport: fakeTransport([]), supervisor: false });
  const server = createDaemonServer({ runtime, socketPath: `\\\\.\\pipe\\${name}`, version: 'test' });
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  await server.listen();
  const script = [
    `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::In)`,
    '$c.Connect(5000)',
    '$buffer = New-Object byte[] 4096',
    '$read = $c.ReadAsync($buffer, 0, $buffer.Length)',
    'if ($read.Wait(2000)) { "READ|" + $read.Result } else { "NODATA" }',
    '$c.Dispose()',
  ].join('; ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.match(output, /NODATA|READ\|0/, output);
});

test('security: Windows daemon refuses a pipe name another process already serves', { skip: process.platform !== 'win32' }, async t => {
  const socketPath = `\\\\.\\pipe\\${pipeName()}`;
  const squatter = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => squatter.close(resolve)));
  const runtime = createAlpRuntime({ transport: fakeTransport([]), supervisor: false });
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  await assert.rejects(server.listen(), { code: 'EADDRINUSE' });
});
