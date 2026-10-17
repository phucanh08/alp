// Credentials and tickets (docs/alp/remote-gateway.md §4): tokens are shown once and stored only as
// hashes; rotation and revocation take effect at once; the file must be private; tickets are
// one-time, short-lived and bound to their Origin; nothing secret reaches a log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialStore, TicketBook, createCredential, createGatewayLogger, credentialsFile, listCredentials, parseToken, revokeCredential, rotateCredential, scrubGatewaySecrets } from '../src/index.js';

async function home(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-cred-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'project');
  await mkdir(workspace);
  return { directory, home: path.join(directory, 'gateway'), workspace };
}

test('a credential is shown once and stored as a hash, with its workspaces resolved by the owner', async t => {
  const { directory, home: gatewayHome, workspace } = await home(t);
  const link = path.join(directory, 'link');
  await symlink(workspace, link);
  const { credential, token } = await createCredential(gatewayHome, { label: 'phone', workspaces: [link], permissions: ['session.write'] });
  assert.ok(parseToken(token));
  assert.deepEqual(credential.permissions, ['session.read', 'session.write'], 'write implies read');
  const project = await createCredential(gatewayHome, { label: 'tasks', workspaces: [workspace], permissions: ['project.write'] });
  assert.deepEqual(project.credential.permissions, ['project.read', 'project.write']);
  assert.equal(credential.workspaces[0].path, link);
  assert.equal(credential.workspaces[0].canonical, await import('node:fs/promises').then(fs => fs.realpath(workspace)));
  const text = await readFile(credentialsFile(gatewayHome), 'utf8');
  assert.ok(!text.includes(parseToken(token).secret), 'the secret is not on disk');
  assert.ok(!('hash' in (await listCredentials(gatewayHome))[0]), 'listing hides the hash');
  if (process.platform !== 'win32') assert.equal((await import('node:fs/promises').then(fs => fs.stat(credentialsFile(gatewayHome)))).mode & 0o777, 0o600);
});

test('creation refuses relative or missing workspaces and host permissions', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  await assert.rejects(createCredential(gatewayHome, { label: 'x', workspaces: ['relative/dir'], permissions: ['session.read'] }), /absolute/);
  await assert.rejects(createCredential(gatewayHome, { label: 'x', workspaces: [`${workspace}/../project`], permissions: ['session.read'] }), /normalized/);
  await assert.rejects(createCredential(gatewayHome, { label: 'x', workspaces: [path.join(workspace, 'missing')], permissions: ['session.read'] }), /ENOENT/);
  await assert.rejects(createCredential(gatewayHome, { label: 'x', workspaces: [workspace], permissions: ['host.admin'] }), /ungrantable/);
  await assert.rejects(createCredential(gatewayHome, { label: 'x', workspaces: [], permissions: ['session.read'] }), /at least one workspace/);
});

test('files.read is held only when named: never by default, implied by nothing, implying nothing', async t => {
  const { directory, home: gatewayHome, workspace } = await home(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.js');
  const env = { ...process.env, ALP_GATEWAY_HOME: gatewayHome, ALP_HOME: directory };
  const create = async (...extra) => JSON.parse((await promisify(execFile)(process.execPath, [cli, 'credential', 'create', '--label', 'x', '--workspace', workspace, '--json', ...extra], { env })).stdout).credential.permissions;
  assert.deepEqual(await create(), ['session.read', 'session.write', 'project.read', 'project.write'], 'the default leaves files.read out');
  assert.deepEqual(await create('--permission', 'session.write,project.write'), ['session.read', 'session.write', 'project.read', 'project.write']);
  assert.deepEqual(await create('--permission', 'session.read', '--permission', 'files.read'), ['session.read', 'files.read']);
  assert.deepEqual(await create('--permission', 'files.read'), ['files.read'], 'files.read implies no other permission');
  const usage = await promisify(execFile)(process.execPath, [cli, 'help'], { env }).then(result => result.stdout, failure => `${failure.stdout}${failure.stderr}`);
  assert.match(usage, /files\.read .*never a default/s);
  const held = (await listCredentials(gatewayHome)).map(entry => entry.permissions.includes('files.read'));
  assert.deepEqual(held, [false, false, true, true]);
});

test('the store verifies tokens, and rotation, revocation and expiry end them with a change notice', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const { credential, token } = await createCredential(gatewayHome, { label: 'a', workspaces: [workspace], permissions: ['session.read'] });
  let now = Date.now();
  const short = await createCredential(gatewayHome, { label: 'b', workspaces: [workspace], permissions: ['session.read'], expiresAt: new Date(now + 60_000).toISOString() });
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0, now: () => now });
  t.after(() => store.close());
  await store.reload();
  const changes = [];
  store.onChange(change => changes.push(Object.fromEntries(change)));
  assert.equal(store.verify(token)?.id, credential.id);
  assert.equal(store.verify(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`), undefined, 'a wrong secret');
  assert.equal(store.verify('alpgw1.0000000000000000.' + 'A'.repeat(43)), undefined, 'an unknown id');
  assert.equal(store.verify('garbage'), undefined);

  const rotated = await rotateCredential(gatewayHome, credential.id);
  await store.reload();
  assert.equal(store.verify(token), undefined, 'the old token is dead');
  assert.equal(store.verify(rotated.token)?.id, credential.id);
  assert.deepEqual(changes.at(-1), { [credential.id]: 'revoked' });

  now += 120_000;
  store.expire();
  assert.equal(store.verify(short.token), undefined, 'expired');
  assert.deepEqual(changes.at(-1), { [short.credential.id]: 'revoked' });

  await revokeCredential(gatewayHome, credential.id);
  await store.reload();
  assert.equal(store.verify(rotated.token), undefined, 'revoked');
  await assert.rejects(rotateCredential(gatewayHome, credential.id), /revoked/);
});

test('a credentials file other users can read is refused: the store fails closed', { skip: process.platform === 'win32' && 'mode bits' }, async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const { token } = await createCredential(gatewayHome, { label: 'a', workspaces: [workspace], permissions: ['session.read'] });
  await chmod(credentialsFile(gatewayHome), 0o644);
  const lines = [];
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0, logger: createGatewayLogger({ write: line => lines.push(line) }) });
  t.after(() => store.close());
  await store.reload();
  assert.equal(store.verify(token), undefined);
  assert.ok(lines.some(line => line.includes('ALP_GATEWAY_CREDENTIALS_UNREADABLE')));
  assert.ok(!lines.join('\n').includes(parseToken(token).secret));
});

test('tickets are one-time, expire, are bound to their Origin and die with their credential', () => {
  let now = 1_000;
  const book = new TicketBook({ ttlMs: 100, perPrincipal: 2, now: () => now });
  const first = book.issue('p1', 'https://app.example');
  assert.equal(book.consume(first.ticket, 'https://evil.example'), undefined, 'another origin');
  assert.equal(book.consume(first.ticket, 'https://app.example'), undefined, 'spent by the failed try');
  const second = book.issue('p1', null);
  assert.equal(book.consume(second.ticket, null), 'p1');
  assert.equal(book.consume(second.ticket, null), undefined, 'single use');
  const third = book.issue('p1', null);
  now += 101;
  assert.equal(book.consume(third.ticket, null), undefined, 'expired');
  book.issue('p2', null);
  const fourth = book.issue('p2', null);
  assert.equal(book.issue('p2', null), undefined, 'too many outstanding');
  book.revoke('p2');
  assert.equal(book.consume(fourth.ticket, null), undefined, 'revoked with its credential');
});

test('log lines never carry tokens or tickets', () => {
  const token = `alpgw1.0123456789abcdef.${'x'.repeat(43)}`;
  const line = scrubGatewaySecrets(`auth ${token} ticket alpgwt.${'y'.repeat(43)} protocol alp.ticket.alpgwt.${'z'.repeat(43)}`);
  assert.ok(!line.includes('x'.repeat(43)) && !line.includes('y'.repeat(43)) && !line.includes('z'.repeat(43)), line);
});
