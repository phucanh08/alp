import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { GIT_CHECK, gitChecksRunning, listWorkspaceDirectory, readWorkspaceFile, relativeSegments, resolveGit } from '@anhlp/alp-daemon/files';

/** A workspace and a directory beside it ("outside"), both removed after the test. */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-files-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

/** Whether git is installed: the .gitignore tests need it (alpd asks git, gitignore.ts). */
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const noGit = !hasGit && 'git is not installed';
/** Makes `root` a Git repository, as a workspace whose .gitignore applies is. */
const repo = root => execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
/** A stand-in git: a Node script that does what `body` says (it gets argv, env, cwd and stdin). */
async function fakeGit(t, body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-fake-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'git');
  await writeFile(file, `#!${process.execPath}\nconst fs = require('node:fs');\nconst input = fs.readFileSync(0, 'utf8');\n${body}\n`);
  await chmod(file, 0o755);
  return { binary: file, directory };
}

const put = async (file, content) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
/** The refusal of a promise: its code and reason, and its message, which must name no host path. */
async function refusal(promise, base) {
  try {
    await promise;
  } catch (error) {
    if (base) assert.ok(!String(error.message).includes(base), `no host path in ${error.message}`);
    return { code: error.code, reason: error.reason };
  }
  assert.fail('expected a refusal');
}

// Every block rule, with a file whose content is a sentinel that must never come back.
const BLOCKED = [
  '.env', '.env.local', '.ENV', '.envrc', 'config/.env.production',
  '.git/config', '.git/HEAD', 'sub/.git/config', '.GIT/config',
  '.alp/mcp/docs.json', '.ssh/id_rsa', '.gnupg/secring', '.aws/credentials', '.azure/token', '.kube/config', '.docker/config.json',
  'id_rsa', 'id_rsa.pub', 'id_ed25519', 'keys/id_ecdsa', 'id_dsa', 'id_xmss', 'id_github', 'deploy/id_work',
  'server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'AuthKey.p8', 'store.jks', 'app.keystore', 'putty.ppk', 'cert.der', 'msg.gpg', 'msg.pgp', 'key.asc', 'vault.kdbx', 'vpn.ovpn', 'terraform.tfstate', 'prod.tfvars', 'SERVER.PEM',
  'credentials', 'credentials.json', '.credentials.json', 'credential.yml', 'secrets.yaml', 'secret.txt', 'config/secrets/db.txt',
  '.netrc', '_netrc', '.npmrc', '.yarnrc.yml', '.pypirc', '.pgpass', '.htpasswd', '.git-credentials', '.dockercfg', '.boto', '.s3cfg', '.mcp.json', 'auth.json', 'kubeconfig', '.claude/settings.local.json',
  '.vault-token', 'application_default_credentials.json', 'gcloud/legacy.db', 'config/gh/hosts.yml', '.bash_history', '.zsh_history', 'service-account.json', 'service_account-prod.json', 'serviceaccount.json', 'token.json', 'terraform.tfstate.backup', 'prod.secrets.yaml',
  'secrets/app.ts', 'secret/notes.md', 'secrets.md',
];

test('blockedFilePath: every rule, without case, and ordinary files are not blocked', () => {
  for (const file of BLOCKED) assert.equal(blockedFilePath(file), true, file);
  for (const file of ['README.md', 'src/server.ts', '.gitignore', '.github/workflows/ci.yml', 'docs/keys.md', 'key.txt', 'secret-santa.md', 'environment.ts', 'src/env.ts', '.claude/settings.json', 'credits.md', 'git/notes.md', 'dot.env.md', 'src/credentials.ts', 'lib/secrets.py', 'src/secret.go', 'inventory/hosts.yml', 'docs/history.md']) {
    assert.equal(blockedFilePath(file), false, file);
  }
});

test('read and list: blocked paths are refused and never listed, their content never returned', async t => {
  const { root } = await workspace(t);
  for (const [index, file] of BLOCKED.entries()) await put(path.join(root, file.replace(/^\.GIT\//, '.git/').replace(/^\.ENV$/, '.env').replace(/^SERVER\.PEM$/, 'server.pem')), `SENTINEL-${index}`);
  await put(path.join(root, 'README.md'), 'hello');
  for (const file of BLOCKED) {
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: file }), root), { code: 1003, reason: 'blocked_path' }, file);
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: file, includeIgnored: true }), root), { code: 1003, reason: 'blocked_path' }, file);
  }
  // Listing every directory: no blocked entry, no sentinel.
  const seen = [];
  const walk = async relative => {
    const { entries } = await listWorkspaceDirectory(root, { ...(relative ? { path: relative } : {}), includeIgnored: true });
    for (const entry of entries) {
      seen.push(entry.path);
      if (entry.kind === 'directory') await walk(entry.path);
    }
  };
  await walk(undefined);
  assert.ok(seen.includes('README.md'));
  for (const entry of seen) assert.equal(blockedFilePath(entry), false, entry);
  assert.ok(!JSON.stringify(seen).includes('SENTINEL'));
  for (const directory of ['.git', '.alp', '.ssh', 'config/secrets']) {
    assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: directory }), root), { code: 1003, reason: 'blocked_path' }, directory);
  }
});

test('paths must be plainly relative', async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'a.txt'), 'x');
  for (const bad of ['', '/etc/passwd', '../outside/x', 'a/../a.txt', './a.txt', 'a//b', 'a/', 'C:/x', 'a\\b', 'a\0b', 'x'.repeat(WORKSPACE_FILES.maxPathLength + 1)]) {
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: bad }), root), { code: -32602, reason: 'invalid_path' }, JSON.stringify(bad));
  }
  assert.throws(() => relativeSegments(42), { reason: 'invalid_path' });
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: '..' }), root), { code: -32602, reason: 'invalid_path' });
  await assert.rejects(readWorkspaceFile('relative', { path: 'a.txt' }), /absolute/);
  await assert.rejects(readWorkspaceFile(path.join(root, 'a.txt'), { path: 'a.txt' }), /not a directory/);
});

test('read: a text file of at most 1 MiB; larger, binary or non-UTF-8 files are refused', async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'src', 'sửa lỗi.ts'), 'export const x = "é";\n');
  await put(path.join(root, 'exact.txt'), 'a'.repeat(WORKSPACE_FILES.maxReadBytes));
  await put(path.join(root, 'big.txt'), 'a'.repeat(WORKSPACE_FILES.maxReadBytes + 1));
  await put(path.join(root, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
  await put(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await put(path.join(root, 'control.txt'), Buffer.alloc(100, 1));
  await put(path.join(root, 'empty.txt'), '');
  const read = await readWorkspaceFile(root, { path: 'src/sửa lỗi.ts' });
  assert.deepEqual({ ...read, modifiedAt: typeof read.modifiedAt }, { path: 'src/sửa lỗi.ts', content: 'export const x = "é";\n', size: 23, modifiedAt: 'string' });
  assert.equal((await readWorkspaceFile(root, { path: 'exact.txt' })).size, WORKSPACE_FILES.maxReadBytes);
  assert.equal((await readWorkspaceFile(root, { path: 'empty.txt' })).content, '');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'big.txt' }), root), { code: 1000, reason: 'too_large' });
  for (const file of ['nul.bin', 'latin1.txt', 'control.txt']) assert.deepEqual(await refusal(readWorkspaceFile(root, { path: file }), root), { code: 1000, reason: 'binary' }, file);
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'missing.txt' }), root), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'src' }), root), { code: 1001, reason: 'not_found' }, 'a directory is not a file');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'exact.txt/x' }), root), { code: 1001, reason: 'not_found' });
});

test('links: no symbolic link is followed, listed or read through; a hard link is refused', async t => {
  const { root, outside } = await workspace(t);
  await put(path.join(outside, 'secret.txt'), 'SENTINEL-outside');
  await put(path.join(outside, 'dir', 'inner.txt'), 'SENTINEL-inner');
  await put(path.join(root, 'real', 'ok.txt'), 'ok');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'));
  await symlink(path.join(outside, 'dir'), path.join(root, 'dir-link'));
  await symlink(path.join(root, 'real', 'ok.txt'), path.join(root, 'inside-link.txt'));
  await symlink('missing', path.join(root, 'dangling'));
  await link(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'));
  for (const [file, reason] of [['file-link.txt', 'linked'], ['dir-link/inner.txt', 'linked'], ['inside-link.txt', 'linked'], ['dangling', 'linked'], ['hard.txt', 'linked']]) {
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: file }), root), { code: 1003, reason }, file);
  }
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'dir-link' }), root), { code: 1003, reason: 'linked' });
  const { entries } = await listWorkspaceDirectory(root);
  assert.deepEqual(entries.map(entry => entry.path), ['real', 'hard.txt'], 'links are not listed; directories first');
  assert.ok(!JSON.stringify(entries).includes(outside));
  // A workspace root reached through a link is read as its real directory.
  const alias = path.join(outside, 'alias');
  await symlink(root, alias);
  assert.equal((await readWorkspaceFile(alias, { path: 'real/ok.txt' })).content, 'ok');
});

test('races: a file or directory swapped while it is read is refused (TOCTOU)', async t => {
  const { root, outside } = await workspace(t);
  await put(path.join(outside, 'secret.txt'), 'SENTINEL-outside');
  await put(path.join(root, 'sub', 'a.txt'), 'inside');
  // The file becomes a link to a file outside between the check and the open.
  const swapFile = async step => {
    if (step !== 'checked') return;
    await unlink(path.join(root, 'sub', 'a.txt'));
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'sub', 'a.txt'));
  };
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'sub/a.txt', probe: swapFile }), root), { code: 1003, reason: 'linked' });
  // Another file takes its name between the check and the open.
  await unlink(path.join(root, 'sub', 'a.txt'));
  await put(path.join(root, 'sub', 'a.txt'), 'inside');
  const replace = async step => {
    if (step !== 'checked') return;
    await put(path.join(root, 'other.txt'), 'SENTINEL-other');
    await rename(path.join(root, 'other.txt'), path.join(root, 'sub', 'a.txt'));
  };
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'sub/a.txt', probe: replace }), root), { code: 1003, reason: 'linked' });
  // Its directory is swapped for a link to outside after the read, and back: the identity check sees it.
  await put(path.join(outside, 'sub', 'a.txt'), 'SENTINEL-outside-sub');
  const swapDirectory = async step => {
    if (step !== 'read') return;
    await rename(path.join(root, 'sub'), path.join(root, 'sub-moved'));
    await symlink(path.join(outside, 'sub'), path.join(root, 'sub'));
  };
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'sub/a.txt', probe: swapDirectory }), root), { code: 1003, reason: 'linked' });
  await unlink(path.join(root, 'sub'));
  await rename(path.join(root, 'sub-moved'), path.join(root, 'sub'));
  // A directory listed and then swapped: the listing is dropped.
  const swapListed = async step => {
    if (step !== 'listed') return;
    await rename(path.join(root, 'sub'), path.join(root, 'sub-moved'));
    await mkdir(path.join(root, 'sub'));
  };
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'sub', probe: swapListed }), root), { code: 1003, reason: 'linked' });
  // Without a race the same reads succeed.
  await rm(path.join(root, 'sub'), { recursive: true });
  await rename(path.join(root, 'sub-moved'), path.join(root, 'sub'));
  await writeFile(path.join(root, 'sub', 'a.txt'), 'inside');
  assert.equal((await readWorkspaceFile(root, { path: 'sub/a.txt', probe: () => {} })).content, 'inside');
});

test('.gitignore: ignored paths are hidden and refused unless includeIgnored, as Git reads the rules', { skip: noGit }, async t => {
  const { root } = await workspace(t);
  repo(root);
  await put(path.join(root, '.gitignore'), [
    '# build output', 'dist/', '*.log', '!keep.log', '/root-only.txt', 'docs/**/draft-*.md', 'cache', '\\#hash.txt', 'trailing.txt   ', 'vendor/*', '!vendor/kept/', 'tmp?.txt', 'data[0-9].csv', '**/generated', '',
  ].join('\n'));
  await put(path.join(root, 'pkg', '.gitignore'), 'local.txt\n!*.log\n/anchored.txt\n');
  const files = ['dist/out.js', 'app.log', 'keep.log', 'root-only.txt', 'pkg/root-only.txt', 'docs/a/b/draft-1.md', 'docs/draft-2.md', 'docs/final.md', 'cache/x.txt', 'src/cache', '#hash.txt', 'trailing.txt', 'vendor/a.js', 'vendor/kept/b.js', 'tmp1.txt', 'tmp10.txt', 'data7.csv', 'datax.csv', 'a/b/generated/c.ts', 'pkg/local.txt', 'pkg/x.log', 'pkg/anchored.txt', 'pkg/sub/anchored.txt', 'pkg/dist/y.js', 'src/main.ts'];
  for (const file of files) await put(path.join(root, file), file);
  const ignored = ['dist/out.js', 'app.log', 'root-only.txt', 'docs/a/b/draft-1.md', 'docs/draft-2.md', 'cache/x.txt', 'src/cache', '#hash.txt', 'trailing.txt', 'vendor/a.js', 'tmp1.txt', 'data7.csv', 'a/b/generated/c.ts', 'pkg/local.txt', 'pkg/anchored.txt', 'pkg/dist/y.js'];
  for (const file of files) {
    const expected = ignored.includes(file);
    const result = await readWorkspaceFile(root, { path: file }).then(() => 'read', error => error.reason);
    assert.equal(result, expected ? 'ignored' : 'read', file);
    assert.equal((await readWorkspaceFile(root, { path: file, includeIgnored: true })).content, file);
  }
  const names = async (relative, includeIgnored = false) => (await listWorkspaceDirectory(root, { ...(relative ? { path: relative } : {}), includeIgnored })).entries.map(entry => entry.name);
  assert.ok(!(await names()).includes('dist') && (await names(undefined, true)).includes('dist'));
  assert.deepEqual(await names('vendor'), ['kept'], 'a re-included directory under an ignored pattern');
  assert.deepEqual(await names('pkg'), ['sub', '.gitignore', 'root-only.txt', 'x.log'], 'a deeper .gitignore re-includes and anchors to its directory');
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'dist' }), root), { code: 1003, reason: 'ignored' });
  assert.ok((await names('dist', true)).includes('out.js'));
  // A .gitignore that is a link is not read.
  await rm(path.join(root, 'pkg', '.gitignore'));
  await put(path.join(root, 'elsewhere.gitignore'), 'main.ts\n');
  await symlink(path.join(root, 'elsewhere.gitignore'), path.join(root, 'src', '.gitignore'));
  assert.equal((await readWorkspaceFile(root, { path: 'src/main.ts' })).content, 'src/main.ts');
});

test('list: entries with kinds, sizes and times; at most maxListEntries, then truncated', async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'b.txt'), 'bb');
  await put(path.join(root, 'A.md'), 'a');
  await put(path.join(root, '.hidden'), 'h');
  await mkdir(path.join(root, 'zdir'));
  const { entries, truncated } = await listWorkspaceDirectory(root);
  assert.equal(truncated, undefined);
  assert.deepEqual(entries.map(({ modifiedAt, ...rest }) => (assert.equal(typeof modifiedAt, 'string'), rest)), [
    { name: 'zdir', path: 'zdir', kind: 'directory' },
    { name: '.hidden', path: '.hidden', kind: 'file', size: 1 },
    { name: 'A.md', path: 'A.md', kind: 'file', size: 1 },
    { name: 'b.txt', path: 'b.txt', kind: 'file', size: 2 },
  ]);
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'b.txt' }), root), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'missing' }), root), { code: 1001, reason: 'not_found' });
  await mkdir(path.join(root, 'many'));
  for (let index = 0; index <= WORKSPACE_FILES.maxListEntries; index++) await writeFile(path.join(root, 'many', `f${index}.txt`), '');
  const many = await listWorkspaceDirectory(root, { path: 'many' });
  assert.equal(many.entries.length, WORKSPACE_FILES.maxListEntries);
  assert.equal(many.truncated, true);
});

test('a private key is refused whatever its name, also in source files exempt from the name rules', async t => {
  const { root } = await workspace(t);
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nSENTINEL\n-----END OPENSSH PRIVATE KEY-----\n';
  await put(path.join(root, 'deploy-key'), pem);
  await put(path.join(root, 'src', 'credentials.ts'), `export const key = \`${pem}\`;\n`);
  await put(path.join(root, 'gcp.json'), JSON.stringify({ type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----\nSENTINEL\n-----END PRIVATE KEY-----\n' }));
  await put(path.join(root, 'putty.txt'), 'PuTTY-User-Key-File-3: ssh-ed25519\nSENTINEL\n');
  await put(path.join(root, 'rsa.txt'), '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL\n');
  await put(path.join(root, 'public.txt'), '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n');
  for (const file of ['deploy-key', 'src/credentials.ts', 'gcp.json', 'putty.txt', 'rsa.txt']) {
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: file }), root), { code: 1003, reason: 'blocked_path' }, file);
  }
  assert.match((await readWorkspaceFile(root, { path: 'public.txt' })).content, /PUBLIC KEY/);
});

test('outside a repository, or without git, .gitignore hides nothing; the block list still applies', { skip: noGit }, async t => {
  const { root } = await workspace(t);
  await put(path.join(root, '.gitignore'), 'build/\n');
  await put(path.join(root, 'build', 'out.js'), 'built');
  await put(path.join(root, '.env'), 'SENTINEL');
  assert.equal((await readWorkspaceFile(root, { path: 'build/out.js' })).content, 'built', 'not a repository: no rules apply');
  assert.ok((await listWorkspaceDirectory(root)).entries.some(entry => entry.name === 'build'));
  const missing = { binary: path.join(root, 'no-such-git') };
  repo(root);
  assert.equal((await readWorkspaceFile(root, { path: 'build/out.js', git: missing })).content, 'built', 'git not installed: no rules apply');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'build/out.js' }), root), { code: 1003, reason: 'ignored' }, 'a repository: git says so');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: '.env', git: missing }), root), { code: 1003, reason: 'blocked_path' });
});

test('git that hangs, fails, crashes or answers what was not asked fails closed: the paths count as ignored, quickly; includeIgnored still reads', async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'src', 'a.ts'), 'a');
  await put(path.join(root, 'b.ts'), 'b');
  const cases = {
    hangs: 'setTimeout(() => {}, 60000);',
    fails: 'process.stderr.write("fatal: detected dubious ownership\\n"); process.exit(128);',
    crashes: 'process.kill(process.pid, "SIGKILL");',
    strays: 'process.stdout.write("../outside\\0"); process.exit(0);',
    floods: 'const chunk = "x".repeat(1 << 20); for (let i = 0; i < 12; i++) process.stdout.write(chunk); process.exit(0);',
  };
  for (const [name, body] of Object.entries(cases)) {
    const { binary } = await fakeGit(t, body);
    const git = { binary, timeoutMs: 300 };
    const started = performance.now();
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'src/a.ts', git }), root), { code: 1003, reason: 'ignored' }, name);
    assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'src', git }), root), { code: 1003, reason: 'ignored' }, name);
    assert.deepEqual((await listWorkspaceDirectory(root, { git })).entries, [], `${name}: every child hidden at the root`);
    assert.ok(performance.now() - started < 3000, `${name} took ${Math.round(performance.now() - started)} ms`);
    assert.equal((await readWorkspaceFile(root, { path: 'src/a.ts', includeIgnored: true, git })).content, 'a', `${name}: includeIgnored asks no git`);
  }
});

test('git runs boxed: argv only, no shell, the real root as cwd, names on stdin with NUL, none of alpd\'s GIT_* variables', async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'src', 'weird $(touch pwned) ;name.ts'), 'x');
  await put(path.join(root, '-n.ts'), 'x');
  const record = path.join(root, '..', 'git-call.json');
  const { binary } = await fakeGit(t, `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).filter(key => /^GIT_/.test(key)), input }));\nprocess.exit(1);`);
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(root, 'elsewhere');
  process.env.GIT_WORK_TREE = '/';
  t.after(() => { for (const [key, value] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.tree]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const listed = await listWorkspaceDirectory(root, { path: 'src', git: { binary } });
  assert.deepEqual(listed.entries.map(entry => entry.name), ['weird $(touch pwned) ;name.ts']);
  const call = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(call.argv, ['-c', 'core.fsmonitor=false', 'check-ignore', '--no-index', '--stdin', '-z']);
  assert.equal(call.cwd, root);
  assert.deepEqual(call.env.sort(), ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT']);
  assert.equal(call.input, './src\0./src/weird $(touch pwned) ;name.ts\0', 'each name as ./<path>: never pathspec magic');
  await readWorkspaceFile(root, { path: '-n.ts', git: { binary } });
  assert.equal(JSON.parse(await readFile(record, 'utf8')).input, './-n.ts\0', 'a name starting with - is data on stdin, never an option');
  await assert.rejects(readFile(path.join(root, 'src', 'pwned')), { code: 'ENOENT' });
});

test('a hostile .gitignore is bounded by the timeout: the answer comes within it, or the path counts as ignored', { skip: noGit }, async t => {
  const { root } = await workspace(t);
  repo(root);
  const letters = 'bcdefghijklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(4);
  const hostile = [...Array.from({ length: 1000 }, () => `*[${letters}]`), ...Array.from({ length: 1000 }, () => `**/*${'a'.repeat(120)}b/**/x`), '*a*a*a*a*a*a*a*a*a*a*a*a*b'];
  await put(path.join(root, '.gitignore'), hostile.join('\n'));
  const segment = 'a'.repeat(150);
  await put(path.join(root, segment, segment, segment, 'x'), 'deep');
  const started = performance.now();
  const read = await readWorkspaceFile(root, { path: `${segment}/${segment}/${segment}/x` }).then(file => file.content, error => error.reason);
  assert.ok(read === 'deep' || read === 'ignored', read);
  await listWorkspaceDirectory(root, { path: `${segment}/${segment}` }).catch(error => assert.equal(error.reason, 'ignored'));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2 * 2000 + 1000, `took ${Math.round(elapsed)} ms`);
});

test('.gitignore edge cases as git: a/** hides what is inside a (not a) and lets !a/keep back, an unclosed [ matches nothing, POSIX classes', { skip: noGit }, async t => {
  const { root } = await workspace(t);
  repo(root);
  await put(path.join(root, '.gitignore'), ['logs/**', '!logs/keep.txt', 'cache/**/', 'broken[', 'v[[:digit:]].txt', '\\!bang.txt', 'sp\\ ', ''].join('\n'));
  for (const file of ['logs/a.txt', 'logs/keep.txt', 'cache/top.txt', 'cache/sub/x.txt', 'broken[', 'broken', 'v1.txt', 'vx.txt', '!bang.txt', 'sp ', 'keep.txt']) await put(path.join(root, file), file);
  const names = (await listWorkspaceDirectory(root)).entries.map(entry => entry.name);
  assert.ok(names.includes('logs') && names.includes('cache'), 'logs/** and cache/**/ do not ignore the directories themselves (git check-ignore)');
  assert.deepEqual((await listWorkspaceDirectory(root, { path: 'logs' })).entries.map(entry => entry.name), ['keep.txt'], 'a/** with !a/keep: keep is shown, as git status shows it');
  assert.deepEqual((await listWorkspaceDirectory(root, { path: 'cache' })).entries.map(entry => entry.name), ['top.txt'], 'cache/**/ ignores directories inside cache, not its files');
  for (const shown of ['broken[', 'broken', 'vx.txt', 'keep.txt']) assert.ok(names.includes(shown), shown);
  for (const hidden of ['v1.txt', '!bang.txt', 'sp ']) assert.ok(!names.includes(hidden), hidden);
});

test('special files and .git as a file: a FIFO is neither listed as readable nor waited on; a .git file is blocked', { skip: process.platform === 'win32' && 'no mkfifo' }, async t => {
  const { root } = await workspace(t);
  const { execFileSync } = await import('node:child_process');
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  await put(path.join(root, '.git'), 'gitdir: /somewhere/else/.git/worktrees/x\n');
  await put(path.join(root, 'a.txt'), 'a');
  // The .git file points nowhere: git cannot tell, so without includeIgnored everything is hidden (fail closed).
  assert.deepEqual((await listWorkspaceDirectory(root)).entries, []);
  const names = (await listWorkspaceDirectory(root, { includeIgnored: true })).entries.map(entry => entry.name);
  assert.deepEqual(names, ['a.txt'], 'no FIFO, no .git');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'pipe', includeIgnored: true }), root), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: '.git' }), root), { code: 1003, reason: 'blocked_path' });
});

test('a file that grows past the limit while it is read is refused as too large', async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'log.txt'), 'start\n');
  const grow = async step => { if (step === 'checked') await writeFile(path.join(root, 'log.txt'), 'a'.repeat(WORKSPACE_FILES.maxReadBytes + 10)); };
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'log.txt', probe: grow }), root), { code: 1000, reason: 'too_large' });
});

test('a git in the workspace never runs: only absolute PATH entries are searched, and git is run by its absolute path', { skip: process.platform === 'win32' && 'POSIX modes' }, async t => {
  const { root } = await workspace(t);
  const marker = path.join(root, '..', 'planted-ran');
  const planted = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`;
  for (const name of ['git', 'git.exe', 'git.com']) { await writeFile(path.join(root, name), planted); await chmod(path.join(root, name), 0o755); }
  await put(path.join(root, 'src', 'a.ts'), 'a');
  assert.equal(resolveGit('git', `.${path.delimiter}${path.delimiter}src`), undefined, 'relative and empty PATH entries are skipped');
  assert.equal(resolveGit('./git', '/usr/bin'), undefined, 'a relative binary is never taken');
  assert.equal(resolveGit(path.join(root, 'git')), path.join(root, 'git'), 'an absolute binary (tests) is taken as it is');
  // A PATH entry inside the workspace (npm/npx put <project>/node_modules/.bin first) is skipped too.
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', '.bin', 'git'), planted);
  await chmod(path.join(root, 'node_modules', '.bin', 'git'), 0o755);
  assert.equal(resolveGit('git', path.join(root, 'node_modules', '.bin'), root), undefined, 'an absolute PATH entry inside the workspace is skipped');
  assert.equal(resolveGit('git', path.join(root, 'node_modules', '.bin')), path.join(root, 'node_modules', '.bin', 'git'), 'without a root it would be found');
  const saved = process.env.PATH;
  process.env.PATH = `.${path.delimiter}${path.delimiter}${path.join(root, 'node_modules', '.bin')}${path.delimiter}${saved ?? ''}`;
  t.after(() => { process.env.PATH = saved; });
  const resolved = resolveGit('git', undefined, root);
  assert.ok(resolved === undefined || (path.isAbsolute(resolved) && !resolved.startsWith(root)), String(resolved));
  assert.equal((await readWorkspaceFile(root, { path: 'src/a.ts' })).content, 'a');
  await listWorkspaceDirectory(root);
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'the planted git never ran');
});

/** A git planted in `directory` that writes a marker beside the workspace when it runs. */
async function plantGit(root, directory) {
  const marker = path.join(root, '..', 'planted-ran');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'git');
  await writeFile(file, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  await chmod(file, 0o755);
  return { file, marker };
}
/** A read and a listing of `root` with `entries` first on PATH; the planted git must not have run. */
async function plantedNeverRuns(root, marker, entries) {
  await put(path.join(root, 'src', 'a.ts'), 'a');
  const saved = process.env.PATH;
  process.env.PATH = [...entries, saved ?? ''].join(path.delimiter);
  try {
    assert.equal((await readWorkspaceFile(root, { path: 'src/a.ts' })).content, 'a');
    await listWorkspaceDirectory(root);
  } finally {
    process.env.PATH = saved;
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'the planted git never ran');
}
const flipCase = text => text.replace(/[a-z]/gi, letter => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
/** Whether `alias` names the same directory as `directory` (a case-insensitive file system). */
const sameDirectory = async (alias, directory) => {
  try { const [a, b] = await Promise.all([stat(alias), stat(directory)]); return a.dev === b.dev && a.ino === b.ino; } catch { return false; }
};

test('a PATH entry naming the workspace in another case is skipped (case-insensitive file systems)', { skip: process.platform === 'win32' && 'POSIX modes' }, async t => {
  const { root } = await workspace(t);
  const bin = path.join(root, 'node_modules', '.bin');
  const { marker } = await plantGit(root, bin);
  const aliases = [flipCase(bin), bin.toLowerCase(), bin.toUpperCase(), path.join(path.dirname(root), flipCase(path.basename(root)), 'node_modules', '.bin')].filter(alias => alias !== bin);
  if (!(await sameDirectory(aliases[0], bin))) { t.skip('case-sensitive file system'); return; }
  for (const alias of aliases) {
    if (!(await sameDirectory(alias, bin))) continue;
    assert.equal(resolveGit('git', alias, root), undefined, `${alias} is the workspace`);
  }
  assert.equal(resolveGit('git', `${aliases[0]}${path.sep}`, root), undefined, 'with a trailing separator too');
  await plantedNeverRuns(root, marker, aliases);
});

test('a PATH entry outside the workspace that links into it is skipped', { skip: process.platform === 'win32' && 'symlinks and POSIX modes' }, async t => {
  const { root, outside } = await workspace(t);
  const { marker } = await plantGit(root, path.join(root, 'tools'));
  await plantGit(root, root);
  await symlink(path.join(root, 'tools'), path.join(outside, 'bin'));
  await symlink(root, path.join(outside, 'project-link'));
  assert.equal(resolveGit('git', path.join(outside, 'bin'), root), undefined, 'a link to a directory in the workspace');
  assert.equal(resolveGit('git', path.join(outside, 'project-link'), root), undefined, 'a link to the workspace itself');
  assert.equal(resolveGit('git', path.join(outside, 'project-link', 'tools'), root), undefined, 'a path through a link to the workspace');
  assert.equal(resolveGit('git', path.join(outside, '..', path.basename(root), '.', 'tools'), root), undefined, 'a path with .. and . into the workspace');
  assert.throws(() => resolveGit('git', path.join(outside, 'bin'), path.join(root, 'missing')), /cannot be examined/, 'a workspace that cannot be examined finds no git');
  await plantedNeverRuns(root, marker, [path.join(outside, 'bin'), path.join(outside, 'project-link'), path.join(outside, 'project-link', 'tools')]);
});

test('a git outside the workspace that links to a file in it is skipped; git is run by its real path', { skip: process.platform === 'win32' && 'symlinks and POSIX modes' }, async t => {
  const { root, outside } = await workspace(t);
  const { file, marker } = await plantGit(root, path.join(root, 'tools'));
  await mkdir(path.join(outside, 'bin'));
  await symlink(file, path.join(outside, 'bin', 'git'));
  await mkdir(path.join(outside, 'via-root'));
  await symlink(path.join(flipCase(root), 'tools', 'git'), path.join(outside, 'via-root', 'git'));
  assert.equal(resolveGit('git', path.join(outside, 'bin'), root), undefined, 'a link to a git in the workspace');
  assert.equal(resolveGit(path.join(outside, 'bin', 'git'), '', root), undefined, 'an absolute binary linking into the workspace');
  assert.equal(resolveGit(file, '', root), undefined, 'an absolute binary in the workspace');
  assert.equal(resolveGit('git', path.join(outside, 'via-root'), root), undefined, 'a link through another spelling of the workspace');
  await plantedNeverRuns(root, marker, [path.join(outside, 'bin'), path.join(outside, 'via-root')]);
  // A link to a git outside the workspace is followed: git runs by its real path.
  const real = path.join(outside, 'real');
  await plantGit(root, real);
  await mkdir(path.join(outside, 'linked'));
  await symlink(path.join(real, 'git'), path.join(outside, 'linked', 'git'));
  assert.equal(resolveGit('git', path.join(outside, 'linked'), root), path.join(real, 'git'));
});

test('names that look like pathspec magic are plain names to git: `:(glob)*`, `:!a`, `:a`', { skip: (noGit || process.platform === 'win32') && 'git and POSIX names' }, async t => {
  const { root } = await workspace(t);
  repo(root);
  await put(path.join(root, '.gitignore'), 'a\n');
  for (const name of [':(glob)*', ':!a', ':a', 'a', 'b']) await put(path.join(root, name), name);
  const names = (await listWorkspaceDirectory(root)).entries.map(entry => entry.name);
  assert.deepEqual(names.filter(name => name !== '.gitignore'), [':!a', ':(glob)*', ':a', 'b'], 'a is ignored; the others are not, and the listing did not fail closed');
  assert.equal((await readWorkspaceFile(root, { path: ':a' })).content, ':a');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'a' }), root), { code: 1003, reason: 'ignored' });
});

test('at most GIT_CHECK.maxConcurrent git processes run at once; a full queue fails closed at once', { skip: process.platform === 'win32' && 'POSIX modes' }, async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'a.ts'), 'a');
  const { binary } = await fakeGit(t, 'setTimeout(() => process.exit(1), 150);');
  let most = 0;
  const sampler = setInterval(() => { most = Math.max(most, gitChecksRunning()); }, 5);
  t.after(() => clearInterval(sampler));
  const reads = await Promise.all(Array.from({ length: 12 }, () => readWorkspaceFile(root, { path: 'a.ts', git: { binary, timeoutMs: 1900 } }).then(file => file.content, error => error.reason)));
  assert.deepEqual(reads, Array(12).fill('a'), 'every read got its turn');
  assert.ok(most >= 1 && most <= GIT_CHECK.maxConcurrent, `at most ${GIT_CHECK.maxConcurrent} at once, saw ${most}`);
  const flood = GIT_CHECK.maxConcurrent + GIT_CHECK.maxQueued + 8;
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: flood }, () => readWorkspaceFile(root, { path: 'a.ts', git: { binary, timeoutMs: 400 } }).then(() => 'read', error => error.reason)));
  assert.ok(results.filter(result => result === 'ignored').length >= 8, 'past the queue: fail closed');
  assert.ok(performance.now() - started < 5000);
  assert.equal(gitChecksRunning(), 0);
});

test('a .git that git cannot use (a worktree whose repository moved) fails closed, unlike no repository at all', { skip: noGit }, async t => {
  const { root } = await workspace(t);
  await writeFile(path.join(root, '.git'), 'gitdir: /nonexistent/repository/.git/worktrees/x\n');
  await put(path.join(root, 'a.ts'), 'a');
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'a.ts' }), root), { code: 1003, reason: 'ignored' });
  assert.equal((await readWorkspaceFile(root, { path: 'a.ts', includeIgnored: true })).content, 'a');
});

test('a timeout kills git and whatever it started (its process group)', { skip: process.platform === 'win32' && 'process groups' }, async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'a.ts'), 'a');
  const pidFile = path.join(root, '..', 'grandchild.pid');
  const { binary } = await fakeGit(t, `const { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\nsetTimeout(() => {}, 60000);`);
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'a.ts', git: { binary, timeoutMs: 400 } }), root), { code: 1003, reason: 'ignored' });
  const pid = Number(await readFile(pidFile, 'utf8'));
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { alive = false; }
  }
  if (alive) process.kill(pid, 'SIGKILL');
  assert.equal(alive, false, 'the grandchild was killed with git');
});
