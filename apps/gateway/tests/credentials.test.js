// Credentials and tickets (docs/alp/remote-gateway.md §4): tokens are shown once and stored only as
// hashes; rotation and revocation take effect at once; the file must be private; tickets are
// one-time, short-lived and bound to their Origin; nothing secret reaches a log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as credentials from '../src/credentials.js';
import { fakeDaemon } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';
import { CredentialStore, TicketBook, createCredential, createGatewayLogger, credentialsFile, listCredentials, parseToken, revokeCredential, rotateCredential, scrubGatewaySecrets } from '../src/index.js';

async function home(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-cred-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'project');
  await mkdir(workspace);
  return { directory, home: path.join(directory, 'gateway'), workspace };
}

test('reissue replaces grants and secret, preserving device identity and invalidating the old grant', async t => {
  const { home: gatewayHome, workspace, directory } = await home(t);
  const second = path.join(directory, 'second');
  await mkdir(second);
  const original = await createCredential(gatewayHome, { label: 'phone', workspaces: [workspace], permissions: ['session.write'], modes: ['cafe'] });
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0 });
  t.after(() => store.close());
  await store.reload();
  const notices = [];
  store.onChange(change => notices.push(Object.fromEntries(change)));
  const issued = await credentials.reissueCredential(gatewayHome, original.credential.id, { workspaces: [second], permissions: ['files.read'], modes: ['pho'] });
  assert.equal(issued.credential.id, original.credential.id);
  assert.equal(issued.credential.createdAt, original.credential.createdAt);
  assert.equal(issued.credential.label, 'phone');
  await store.reload();
  assert.equal(store.verify(original.token), undefined);
  assert.deepEqual([...store.verify(issued.token).permissions], ['files.read']);
  assert.equal(store.verify(issued.token).workspaces[0].path, second);
  assert.deepEqual([...store.verify(issued.token).modes], ['pho']);
  assert.deepEqual(notices, [{ [original.credential.id]: 'revoked' }]);
  const disk = await readFile(credentialsFile(gatewayHome), 'utf8');
  assert.ok(!disk.includes(parseToken(issued.token).secret));
  const restarted = new CredentialStore({ home: gatewayHome, pollMs: 0 });
  t.after(() => restarted.close());
  await restarted.reload();
  assert.equal(restarted.verify(original.token), undefined);
  assert.deepEqual([...restarted.verify(issued.token).permissions], ['files.read']);
  for (const options of [{ permissions: ['host.admin'] }, { permissions: [] }, { workspaces: ['relative'] }, { workspaces: [] }, { modes: [] }, { expiresAt: 'yesterday' }, { label: '' }]) {
    await assert.rejects(credentials.reissueCredential(gatewayHome, original.credential.id, options));
    assert.equal(await readFile(credentialsFile(gatewayHome), 'utf8'), disk, 'invalid edits leave disk unchanged');
  }
  await revokeCredential(gatewayHome, original.credential.id);
  await assert.rejects(credentials.reissueCredential(gatewayHome, original.credential.id, {}), /revoked/);
});

test('CLI edit/reissue replaces named grants, retains omitted fields, and rejects invalid edits', async t => {
  const { home: gatewayHome, workspace, directory } = await home(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(import.meta.dirname, '../src/cli.js'), 'credential', ...args], { env: { ...process.env, ALP_GATEWAY_HOME: gatewayHome, ALP_HOME: directory } });
  const original = JSON.parse((await run('create', '--label', 'phone', '--workspace', workspace, '--permission', 'session.write', '--mode', 'cafe', '--json')).stdout);
  const edited = JSON.parse((await run('edit', original.credential.id, '--permission', 'files.read', '--expires-in-days', '2', '--json')).stdout);
  assert.equal(edited.credential.id, original.credential.id);
  assert.equal(edited.credential.createdAt, original.credential.createdAt);
  assert.deepEqual(edited.credential.workspaces, original.credential.workspaces);
  assert.deepEqual(edited.credential.modes, ['cafe']);
  assert.deepEqual(edited.credential.permissions, ['files.read']);
  assert.notEqual(edited.token, original.token);
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0 });
  t.after(() => store.close());
  await store.reload();
  assert.equal(store.verify(original.token), undefined);
  assert.ok(store.verify(edited.token));
  const reissued = JSON.parse((await run('reissue', original.credential.id, '--json')).stdout);
  assert.deepEqual(reissued.credential.permissions, ['files.read']);
  const before = await readFile(credentialsFile(gatewayHome), 'utf8');
  for (const flags of [['--permission', 'host.admin'], ['--workspace', 'relative'], ['--permission', ''], ['--expires-in-days', 'Infinity']]) {
    await assert.rejects(run('edit', original.credential.id, ...flags));
    assert.equal(await readFile(credentialsFile(gatewayHome), 'utf8'), before);
  }
  await run('revoke', original.credential.id);
  await assert.rejects(run('edit', original.credential.id, '--permission', 'session.write'), /revoked/);
});

test('an agent credential keeps its mark through rotate, update and reissue; a user credential is unchanged (t-53aa)', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const user = await createCredential(gatewayHome, { label: 'phone', workspaces: [workspace], permissions: ['session.write'] });
  assert.equal(user.credential.agent, undefined, 'a credential is a user\'s unless --agent');
  const agent = await createCredential(gatewayHome, { label: 'bot', workspaces: [workspace], permissions: ['session.write'], agent: true });
  assert.equal(agent.credential.agent, true);
  await assert.rejects(createCredential(gatewayHome, { label: 'odd', workspaces: [workspace], permissions: ['session.write'], agent: 'yes' }), /agent must be true or false/);
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0 });
  t.after(() => store.close());
  await store.reload();
  const userGrant = store.verify(user.token);
  assert.equal(userGrant.agent, undefined);
  assert.equal(store.verify(agent.token).agent, true);

  // A user credential's fingerprint, its epoch when it has no scopeId, keeps its old form.
  const stored = (await credentials.readCredentials(gatewayHome)).credentials.find(entry => entry.id === user.credential.id);
  assert.equal(userGrant.fingerprint, JSON.stringify([stored.workspaces, stored.permissions, null, null, stored.worktreeMappings, stored.scopeId]));

  const rotated = await rotateCredential(gatewayHome, agent.credential.id);
  assert.equal(rotated.credential.agent, true);
  const updated = await credentials.updateCredential(gatewayHome, agent.credential.id, { permissions: ['session.read'] });
  assert.equal(updated.credential.agent, true);
  const reissued = await credentials.reissueCredential(gatewayHome, agent.credential.id, { label: 'bot 2' });
  assert.equal(reissued.credential.agent, true);
  const before = await readFile(credentialsFile(gatewayHome), 'utf8');
  await assert.rejects(credentials.reissueCredential(gatewayHome, agent.credential.id, { agent: false }), /stays one/);
  assert.equal(await readFile(credentialsFile(gatewayHome), 'utf8'), before, 'a refused reissue writes nothing');
  // A user credential may become an agent's (it only takes away); the change closes its connections.
  const notices = [];
  store.onChange(change => notices.push(Object.fromEntries(change)));
  await store.reload();
  notices.length = 0;
  const marked = await credentials.reissueCredential(gatewayHome, user.credential.id, { agent: true });
  assert.equal(marked.credential.agent, true);
  await store.reload();
  assert.equal(store.verify(marked.token).agent, true);
  assert.deepEqual(notices, [{ [user.credential.id]: 'revoked' }]);
});

test('a hand-edited agent mark that is not true leaves the credential unusable; true marks it (t-53aa)', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const { credential, token } = await createCredential(gatewayHome, { label: 'phone', workspaces: [workspace], permissions: ['session.write'] });
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0 });
  t.after(() => store.close());
  await store.reload();
  const before = store.verify(token);
  const notices = [];
  store.onChange(change => notices.push(Object.fromEntries(change)));
  const file = credentialsFile(gatewayHome);
  const edit = async agent => {
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.credentials[0].agent = agent;
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
    await store.reload();
  };
  for (const value of ['true', 1, false, null, {}]) {
    await edit(value);
    assert.equal(store.verify(token), undefined, `agent: ${JSON.stringify(value)} is refused`);
  }
  await edit(true);
  const after = store.verify(token);
  assert.equal(after.agent, true);
  assert.notEqual(after.fingerprint, before.fingerprint, 'gaining the mark is a grant change');
  assert.ok(notices.length >= 1 && notices.every(notice => notice[credential.id]), JSON.stringify(notices));
});

test('CLI --agent makes an agent credential, list shows it, and reissue keeps it (t-53aa)', async t => {
  const { home: gatewayHome, workspace, directory } = await home(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(import.meta.dirname, '../src/cli.js'), 'credential', ...args], { env: { ...process.env, ALP_GATEWAY_HOME: gatewayHome, ALP_HOME: directory } });
  const user = JSON.parse((await run('create', '--label', 'phone', '--workspace', workspace, '--json')).stdout);
  assert.equal(user.credential.agent, undefined);
  const bot = JSON.parse((await run('create', '--label', 'bot', '--workspace', workspace, '--agent', '--json')).stdout);
  assert.equal(bot.credential.agent, true);
  const listed = (await run('list')).stdout.split('\n');
  assert.match(listed.find(line => line.startsWith(bot.credential.id)), /  agent$/);
  assert.doesNotMatch(listed.find(line => line.startsWith(user.credential.id)), /agent/);
  const reissued = JSON.parse((await run('reissue', bot.credential.id, '--label', 'bot 2', '--json')).stdout);
  assert.equal(reissued.credential.agent, true, 'reissue without --agent keeps the mark');
  await assert.rejects(run('reissue', bot.credential.id, '--agent=false'), 'a boolean flag takes no value');
});

test('reissue closes active old-grant connections, kills outstanding tickets and enforces the replacement grant', async t => {
  const { workspace } = await home(t);
  const daemon = fakeDaemon();
  const gw = await startGateway(t, { daemon, credentials: { phone: { workspaces: [workspace] } } });
  const active = await gw.rawSession('phone');
  const pending = await gw.ticket(gw.tokens.phone);
  const issued = await credentials.reissueCredential(gw.home, gw.ids.phone, { permissions: ['files.read'] });
  await gw.store.reload();
  assert.equal((await active.closed).code, 4401);
  assert.equal((await gw.ticket(gw.tokens.phone)).status, 401);
  assert.equal((await gw.raw(pending.body.subprotocols)).refused, 401);
  gw.tokens.phone = issued.token;
  const replacement = await gw.sdk('phone');
  await assert.rejects(replacement.client.request('session.list', {}), error => error.code === 1003);
  assert.equal(daemon.calls('session.list').length, 0, 'old session.read grant cannot reach daemon');
});

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

test('update replaces workspaces and permissions in place: the token stays valid and open connections close with 4403', async t => {
  const { workspace, directory } = await home(t);
  const second = path.join(directory, 'second');
  await mkdir(second);
  const daemon = fakeDaemon();
  const gw = await startGateway(t, { daemon, credentials: { phone: { workspaces: [workspace], permissions: ['session.read'] } } });
  const before = gw.store.verify(gw.tokens.phone);
  const stored = (await credentials.readCredentials(gw.home)).credentials[0];
  const active = await gw.rawSession('phone');
  const pending = await gw.ticket(gw.tokens.phone);
  const notices = [];
  gw.store.onChange(change => notices.push(Object.fromEntries(change)));

  const updated = await credentials.updateCredential(gw.home, gw.ids.phone, { workspaces: [workspace, second], permissions: ['session.write', 'project.read'] });
  assert.equal(updated.token, undefined, 'no new token');
  assert.ok(!('hash' in updated.credential));
  assert.deepEqual(updated.credential.permissions, ['session.read', 'session.write', 'project.read'], 'checked and expanded as at creation');
  await gw.store.reload();
  assert.equal((await active.closed).code, 4403, 'the old grant\'s connection closes as a changed grant');
  assert.deepEqual(notices, [{ [gw.ids.phone]: 'changed' }]);
  assert.equal((await gw.raw(pending.body.subprotocols)).refused, 401, 'tickets issued under the old grant die');

  const after = gw.store.verify(gw.tokens.phone);
  assert.ok(after, 'the same token still verifies');
  assert.equal(after.secretHash, before.secretHash);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.scopeId, before.scopeId, 'the principal epoch stays');
  const disk = (await credentials.readCredentials(gw.home)).credentials[0];
  assert.equal(disk.hash, stored.hash);
  assert.deepEqual([disk.id, disk.label, disk.createdAt, disk.scopeId, disk.rotatedAt], [stored.id, stored.label, stored.createdAt, stored.scopeId, undefined]);
  assert.deepEqual(disk.workspaces.map(entry => entry.path), [workspace, second]);
  if (process.platform !== 'win32') assert.equal((await stat(credentialsFile(gw.home))).mode & 0o777, 0o600);

  const issued = await gw.ticket(gw.tokens.phone);
  assert.equal(issued.status, 201, 'a new ticket with the unchanged token');
  assert.deepEqual(issued.body.principal.permissions, ['session.read', 'session.write', 'project.read']);
  assert.deepEqual(issued.body.principal.workspaces, [workspace, second]);
  const reopened = await gw.raw(issued.body.subprotocols);
  assert.ok(reopened.socket, 'the new ticket opens a connection under the new grant');
  reopened.socket.close();

  // Only the supplied field changes.
  await credentials.updateCredential(gw.home, gw.ids.phone, { permissions: ['session.read'] });
  const narrowed = (await credentials.readCredentials(gw.home)).credentials[0];
  assert.deepEqual([narrowed.permissions, narrowed.workspaces.map(entry => entry.path), narrowed.hash], [['session.read'], [workspace, second], stored.hash]);
});

test('update rejects invalid input and revoked credentials without touching the file', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const { credential, token } = await createCredential(gatewayHome, { label: 'phone', workspaces: [workspace], permissions: ['session.read'] });
  const disk = await readFile(credentialsFile(gatewayHome), 'utf8');
  for (const options of [undefined, {}, { permissions: ['host.admin'] }, { permissions: [] }, { permissions: 'session.read' }, { workspaces: [] }, { workspaces: ['relative'] }, { workspaces: [`${workspace}/../project`] }, { workspaces: [path.join(workspace, 'missing')] }, { workspaces: [workspace], permissions: ['nope'] }]) {
    await assert.rejects(credentials.updateCredential(gatewayHome, credential.id, options), JSON.stringify(options));
    assert.equal(await readFile(credentialsFile(gatewayHome), 'utf8'), disk, `invalid update ${JSON.stringify(options)} leaves disk unchanged`);
  }
  await assert.rejects(credentials.updateCredential(gatewayHome, '0000000000000000', { permissions: ['session.read'] }), /No credential/);
  assert.equal(await readFile(credentialsFile(gatewayHome), 'utf8'), disk);
  await revokeCredential(gatewayHome, credential.id);
  const revoked = await readFile(credentialsFile(gatewayHome), 'utf8');
  await assert.rejects(credentials.updateCredential(gatewayHome, credential.id, { permissions: ['session.write'] }), /revoked/);
  assert.equal(await readFile(credentialsFile(gatewayHome), 'utf8'), revoked);
  const store = new CredentialStore({ home: gatewayHome, pollMs: 0 });
  t.after(() => store.close());
  await store.reload();
  assert.equal(store.verify(token), undefined, 'a revoked credential stays revoked');
});

test('writeCredentials retries transient EPERM/EACCES/EBUSY on atomic rename and recovers', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const originalRename = nodeFs.promises.rename;
  let calls = 0;
  nodeFs.promises.rename = async function(from, to) {
    calls++;
    if (calls <= 2) {
      const err = new Error('EPERM: operation not permitted, rename');
      // @ts-ignore
      err.code = calls === 1 ? 'EPERM' : 'EBUSY';
      throw err;
    }
    return originalRename.call(this, from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    nodeFs.promises.rename = originalRename;
    syncBuiltinESMExports();
  });

  const { credential, token } = await createCredential(gatewayHome, { label: 'recovering', workspaces: [workspace], permissions: ['session.read'] });
  assert.equal(calls, 3, 'retried twice and succeeded on third attempt');
  assert.ok(parseToken(token));
  assert.equal(credential.label, 'recovering');

  const disk = await readFile(credentialsFile(gatewayHome), 'utf8');
  assert.ok(disk.includes(credential.id));
  if (process.platform !== 'win32') {
    assert.equal((await stat(credentialsFile(gatewayHome))).mode & 0o777, 0o600);
  }

  // Rotate credential with injected EACCES
  let rotateCalls = 0;
  nodeFs.promises.rename = async function(from, to) {
    rotateCalls++;
    if (rotateCalls <= 2) {
      const err = new Error('EACCES: permission denied, rename');
      // @ts-ignore
      err.code = 'EACCES';
      throw err;
    }
    return originalRename.call(this, from, to);
  };
  syncBuiltinESMExports();

  const rotated = await rotateCredential(gatewayHome, credential.id);
  assert.equal(rotateCalls, 3, 'rotate retried twice and succeeded on third attempt');
  assert.ok(parseToken(rotated.token));
  assert.notEqual(rotated.token, token);
});

test('writeCredentials rethrows and cleans up temp files when rename retries are exhausted', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const originalRename = nodeFs.promises.rename;
  let calls = 0;
  nodeFs.promises.rename = async function(from, to) {
    calls++;
    const err = new Error('EPERM: operation not permitted, rename');
    // @ts-ignore
    err.code = 'EPERM';
    throw err;
  };
  syncBuiltinESMExports();
  t.after(() => {
    nodeFs.promises.rename = originalRename;
    syncBuiltinESMExports();
  });

  await assert.rejects(
    createCredential(gatewayHome, { label: 'exhausted', workspaces: [workspace], permissions: ['session.read'] }),
    error => /** @type {any} */ (error)?.code === 'EPERM'
  );
  assert.equal(calls, credentials.RENAME_MAX_RETRIES + 1, 'retried up to RENAME_MAX_RETRIES then gave up');

  // Verify that any temporary files were cleaned up
  const entries = await readdir(gatewayHome).catch(() => []);
  const tmpFiles = entries.filter(name => name.includes('.tmp'));
  assert.deepEqual(tmpFiles, [], 'temporary files cleaned up on failure');
});

test('writeCredentials fails immediately on non-retriable rename errors without retrying', async t => {
  const { home: gatewayHome, workspace } = await home(t);
  const originalRename = nodeFs.promises.rename;
  let calls = 0;
  nodeFs.promises.rename = async function(from, to) {
    calls++;
    const err = new Error('EISDIR: illegal operation on a directory, rename');
    // @ts-ignore
    err.code = 'EISDIR';
    throw err;
  };
  syncBuiltinESMExports();
  t.after(() => {
    nodeFs.promises.rename = originalRename;
    syncBuiltinESMExports();
  });

  await assert.rejects(
    createCredential(gatewayHome, { label: 'fail-fast', workspaces: [workspace], permissions: ['session.read'] }),
    error => /** @type {any} */ (error)?.code === 'EISDIR'
  );
  assert.equal(calls, 1, 'did not retry non-retriable EISDIR error');

  const entries = await readdir(gatewayHome).catch(() => []);
  const tmpFiles = entries.filter(name => name.includes('.tmp'));
  assert.deepEqual(tmpFiles, [], 'temporary files cleaned up on failure');
});

test('renameWithRetry unit contract: backoff schedule, bounds and error filtering', async t => {
  const delays = [];
  const sleepMock = async ms => { delays.push(ms); };
  let attempts = 0;

  // Custom 4 retries, initial backoff 10, max backoff 30
  const customOptions = {
    retries: 4,
    initialBackoffMs: 10,
    maxBackoffMs: 30,
    sleep: sleepMock,
  };

  const { directory } = await home(t);
  const src = path.join(directory, 'src.txt');
  const dst = path.join(directory, 'dst.txt');
  await writeFile(src, 'test content');

  const originalRename = nodeFs.promises.rename;
  nodeFs.promises.rename = async function(from, to) {
    attempts++;
    if (attempts <= 3) {
      const err = new Error('EBUSY: resource busy');
      // @ts-ignore
      err.code = 'EBUSY';
      throw err;
    }
    return originalRename.call(this, from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    nodeFs.promises.rename = originalRename;
    syncBuiltinESMExports();
  });

  await credentials.renameWithRetry(src, dst, customOptions);
  assert.equal(attempts, 4);
  // Delays: 10 * 2^0 = 10, 10 * 2^1 = 20, min(10 * 2^2, 30) = 30
  assert.deepEqual(delays, [10, 20, 30]);
  assert.equal(await readFile(dst, 'utf8'), 'test content');
});
