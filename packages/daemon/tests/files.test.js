import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { FIND_LIMITS, GIT_CHECK, createFindPages, findWorkspaceEntries, gitChecksRunning, listWorkspaceDirectory, previewWorkspaceFile, readWorkspaceFile, relativeSegments, resolveGit, searchHostDirectories, searchWorkspaceFiles } from '@anhlp/alp-daemon/files';

/** A workspace and a directory beside it ("outside"), both removed after the test. */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-files-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
/**
 * Windows runs no script as a program without a shell, and alpd runs git with none: there the
 * stand-in git is git.exe, built once from support/fake-git.cs with the C# compiler of the .NET
 * Framework that Windows ships, which runs the script with node (its arguments, cwd, environment
 * and stdio unchanged) and takes node down with it when it is killed.
 */
const csc = process.platform === 'win32'
  ? ['Framework64', 'Framework'].map(bits => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', bits, 'v4.0.30319', 'csc.exe')).find(file => existsSync(file))
  : undefined;
const noFakeGit = process.platform === 'win32' && !csc && 'no C# compiler (.NET Framework 4) to build a stand-in git.exe';
let launcher;
const fakeGitExe = () => (launcher ??= (async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-fake-git-exe-'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  const exe = path.join(directory, 'git.exe');
  execFileSync(csc, ['-nologo', '-optimize', `-out:${exe}`, fileURLToPath(new URL('./support/fake-git.cs', import.meta.url))], { stdio: 'pipe', windowsHide: true });
  return exe;
})());
/** A stand-in git: a Node script that does what `body` says (it gets argv, env, cwd and stdin). */
async function fakeGit(t, body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-fake-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `const fs = require('node:fs');\nconst input = fs.readFileSync(0, 'utf8');\n${body}\n`;
  if (process.platform === 'win32') {
    const file = path.join(directory, 'git.exe');
    await copyFile(await fakeGitExe(), file);
    await writeFile(path.join(directory, 'git.js'), script);
    await writeFile(path.join(directory, 'git.node'), process.execPath);
    return { binary: file, directory };
  }
  const file = path.join(directory, 'git');
  await writeFile(file, `#!${process.execPath}\n${script}`);
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
  // Its directory is swapped for a link to outside, before the open or after the read: the
  // handle's identity check, or the directories' check after the read, sees it.
  await put(path.join(outside, 'sub', 'a.txt'), 'SENTINEL-outside-sub');
  await writeFile(path.join(root, 'sub', 'a.txt'), 'inside');
  const swapDirectory = at => async step => {
    if (step !== at) return;
    await rename(path.join(root, 'sub'), path.join(root, 'sub-moved'));
    await symlink(path.join(outside, 'sub'), path.join(root, 'sub'));
  };
  const swapBack = async () => {
    await unlink(path.join(root, 'sub'));
    await rename(path.join(root, 'sub-moved'), path.join(root, 'sub'));
  };
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'sub/a.txt', probe: swapDirectory('checked') }), root), { code: 1003, reason: 'linked' });
  await swapBack();
  if (process.platform === 'win32') {
    // NTFS renames no directory that holds an open file: while the file is read, its directory
    // cannot be swapped, and what is read is the file inside. Where the swap does happen, it is refused.
    let swap;
    const probe = async step => {
      if (step !== 'read') return;
      swap = await swapDirectory('read')(step).then(() => 'swapped', error => error.code);
    };
    const read = await readWorkspaceFile(root, { path: 'sub/a.txt', probe }).then(file => file.content, error => ({ code: error.code, reason: error.reason }));
    if (swap === 'swapped') {
      assert.deepEqual(read, { code: 1003, reason: 'linked' });
      await swapBack();
    } else {
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(swap), `the swap failed for another reason: ${swap}`);
      assert.equal(read, 'inside');
    }
  } else {
    assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'sub/a.txt', probe: swapDirectory('read') }), root), { code: 1003, reason: 'linked' });
    await swapBack();
  }
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
  // Git refuses a linked .gitignore with a diagnostic. Unknown rules fail closed.
  await rm(path.join(root, 'pkg', '.gitignore'));
  await put(path.join(root, 'elsewhere.gitignore'), 'main.ts\n');
  await symlink(path.join(root, 'elsewhere.gitignore'), path.join(root, 'src', '.gitignore'));
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'src/main.ts' }), root), { code: 1003, reason: 'ignored' });
  assert.equal((await readWorkspaceFile(root, { path: 'src/main.ts', includeIgnored: true })).content, 'src/main.ts');
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

test('git that hangs, fails, crashes or answers what was not asked fails closed: the paths count as ignored, quickly; includeIgnored still reads', { skip: noFakeGit }, async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'src', 'a.ts'), 'a');
  await put(path.join(root, 'b.ts'), 'b');
  // The control: this stand-in git runs and is believed, so the refusals below are its doing.
  const answers = await fakeGit(t, 'process.exit(1);');
  assert.equal((await readWorkspaceFile(root, { path: 'src/a.ts', git: { binary: answers.binary } })).content, 'a', 'a git that says none is ignored');
  const cases = {
    diagnosticExit1: 'process.stderr.write("fatal: cannot read ignore rules\\n"); process.exit(1);',
    outputExit1: 'process.stdout.write(input); process.exit(1);',
    emptyExit0: 'process.exit(0);',
    unterminated: 'process.stdout.write(input.slice(0, -1)); process.exit(0);',
    hangs: 'setTimeout(() => {}, 60000);',
    fails: 'process.stderr.write("fatal: detected dubious ownership\\n"); process.exit(128);',
    // POSIX: killed by a signal. Windows has no signals: a self-kill there is TerminateProcess with
    // exit status 1, which is git's own "none is ignored"; a crash there ends with an abnormal status.
    crashes: process.platform === 'win32' ? 'process.abort();' : 'process.kill(process.pid, "SIGKILL");',
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

test('search respects nested Git ignores and negation before applying the result limit', { skip: noGit }, async t => {
  const { root } = await workspace(t);
  repo(root);
  await put(path.join(root, '.gitignore'), 'ignored/\n*.generated.ts\n');
  await put(path.join(root, 'src', '.gitignore'), '*.ts\n!visible.ts\n');
  for (const file of ['ignored/deep/a.ts', 'a.generated.ts', 'src/hidden.ts', 'src/visible.ts', 'z.ts']) await put(path.join(root, file), 'text');
  assert.deepEqual((await searchWorkspaceFiles(root, { limit: 1 })).files, [{ path: 'z.ts' }]);
  assert.deepEqual((await searchWorkspaceFiles(root, { query: 'ts', limit: 100 })).files.map(file => file.path).sort(), ['src/visible.ts', 'z.ts']);
});

test('search fails closed on Git failure and preserves missing-git/nonrepo fallback', { skip: noFakeGit || noGit }, async t => {
  const { root } = await workspace(t);
  await put(path.join(root, 'src', 'a.ts'), 'text');
  await put(path.join(root, '.gitignore'), '*.ts\n');
  assert.deepEqual((await searchWorkspaceFiles(root)).files, [{ path: 'src/a.ts' }], 'no repository');
  repo(root);
  assert.deepEqual((await searchWorkspaceFiles(root, { git: { binary: path.join(root, 'missing-git') } })).files, [{ path: 'src/a.ts' }], 'no Git');
  for (const body of ['process.exit(128);', 'process.stderr.write("fatal: rules unavailable"); process.exit(1);', 'setTimeout(() => {}, 60000);']) {
    const { binary } = await fakeGit(t, body);
    const started = performance.now();
    assert.deepEqual((await searchWorkspaceFiles(root, { git: { binary, timeoutMs: 100 } })).files, []);
    assert.ok(performance.now() - started < 2000, 'Git failure is bounded');
  }
});

test('a resolved git whose interpreter is missing fails closed on spawn ENOENT', { skip: process.platform === 'win32' && 'POSIX interpreter' }, async t => {
  const { root, outside } = await workspace(t);
  await put(path.join(root, 'a.ts'), 'text');
  const binary = path.join(outside, 'git');
  await writeFile(binary, '#!/nonexistent/alp-test-interpreter\n');
  await chmod(binary, 0o755);
  assert.deepEqual(await refusal(readWorkspaceFile(root, { path: 'a.ts', git: { binary } }), root), { code: 1003, reason: 'ignored' });
});

test('search batches each level and never descends into an ignored subtree', { skip: noFakeGit }, async t => {
  const { root, outside } = await workspace(t);
  for (const file of ['ignored/deep/a.ts', 'src/a.ts', 'src/b.ts', 'top.ts']) await put(path.join(root, file), 'text');
  const record = path.join(outside, 'calls.jsonl');
  const { binary } = await fakeGit(t, `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(input.split('\\0').filter(Boolean)) + '\\n');
    const ignored = input.split('\\0').filter(entry => entry === './ignored');
    if (ignored.length) process.stdout.write(ignored.join('\\0') + '\\0');
    process.exit(ignored.length ? 0 : 1);`);
  const result = await searchWorkspaceFiles(root, { git: { binary } });
  assert.deepEqual(result.files.map(file => file.path).sort(), ['src/a.ts', 'src/b.ts', 'top.ts']);
  const calls = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2, 'one Git process per level, rather than per file');
  assert.deepEqual(calls[0].sort(), ['./ignored', './src', './top.ts']);
  assert.deepEqual(calls[1].sort(), ['./src/a.ts', './src/b.ts']);
  // Exhaustion before checking ignore status returns no unchecked candidates.
  let tick = 0;
  assert.deepEqual(await searchWorkspaceFiles(root, { now: () => (tick += 4000), git: { binary } }), { files: [], truncated: true });
  assert.equal((await readFile(record, 'utf8')).trim().split('\n').length, 2, 'no Git work after deadline');
});

test('git runs boxed: argv only, no shell, the real root as cwd, names on stdin with NUL, none of alpd\'s GIT_* variables', { skip: noFakeGit }, async t => {
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

// ---- workspace.files.browse (docs/protocol/alp-json-rpc-v1.md §12.11) ----

const owner = {};
/** Every page of a find, as the Paseo bridge reads one. */
async function allPages(page, root, params, who = owner) {
  const entries = [];
  let cursor;
  do {
    const answer = await page(who, root, { ...params, ...(cursor ? { cursor } : {}) });
    entries.push(...answer.entries);
    cursor = answer.nextCursor;
  } while (cursor);
  return entries;
}

test('find: pages of one snapshot cover every name once; a cursor is bound to its connection, params and lifetime', async t => {
  const { root } = await workspace(t);
  for (let index = 0; index < 2500; index++) await put(path.join(root, `d${index % 5}`, `f${String(index).padStart(4, '0')}.txt`), '');
  let clock = 0;
  const page = createFindPages({ now: () => clock });
  const first = await page(owner, root, { limit: 1000 });
  assert.equal(first.entries.length, 1000);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{22}\.1000$/);
  // A file added after the first page is not in this snapshot: the pages stay one consistent set.
  await put(path.join(root, 'late.txt'), '');
  const second = await page(owner, root, { limit: 1000, cursor: first.nextCursor });
  const third = await page(owner, root, { limit: 1000, cursor: second.nextCursor });
  assert.equal(third.nextCursor, undefined);
  const paths = [...first.entries, ...second.entries, ...third.entries].map(entry => entry.path);
  assert.equal(paths.length, 2500);
  assert.equal(new Set(paths).size, 2500, 'no name twice');
  assert.deepEqual(paths, [...paths].sort(), 'path order');
  assert.ok(!paths.includes('late.txt'));
  // Its last page dropped the snapshot; a new walk sees the new file.
  assert.deepEqual(await refusal(page(owner, root, { limit: 1000, cursor: second.nextCursor })), { code: -32602, reason: 'invalid_cursor' });
  assert.ok((await allPages(page, root, {})).some(entry => entry.path === 'late.txt'));
  const again = await page(owner, root, { limit: 1000 });
  for (const [who, params] of [[{}, {}], [owner, { query: 'f1' }], [owner, { kinds: ['directory'] }], [owner, { matchMode: 'suffix' }]]) {
    assert.deepEqual(await refusal(page(who, root, { limit: 1000, ...params, cursor: again.nextCursor })), { code: -32602, reason: 'invalid_cursor' }, JSON.stringify(params));
  }
  for (const cursor of ['x', `${again.nextCursor}0`, again.nextCursor.replace(/\.\d+$/, '.99999')]) {
    assert.deepEqual(await refusal(page(owner, root, { limit: 1000, cursor })), { code: -32602, reason: 'invalid_cursor' }, cursor);
  }
  assert.equal((await page(owner, root, { limit: 1000, cursor: again.nextCursor })).entries.length, 1000, 'the right owner and params page on');
  clock += FIND_LIMITS.ttlMs + 1;
  const stale = await page(owner, root, { limit: 1000 });
  clock += FIND_LIMITS.ttlMs + 1;
  assert.deepEqual(await refusal(page(owner, root, { limit: 1000, cursor: stale.nextCursor })), { code: -32602, reason: 'invalid_cursor' }, 'expired');
  // At most FIND_LIMITS.snapshots are kept: the oldest go first.
  const cursors = [];
  for (let index = 0; index <= FIND_LIMITS.snapshots; index++) cursors.push((await page(owner, root, { limit: 1 })).nextCursor);
  assert.deepEqual(await refusal(page(owner, root, { limit: 1, cursor: cursors[0] })), { code: -32602, reason: 'invalid_cursor' });
  assert.equal((await page(owner, root, { limit: 1, cursor: cursors.at(-1) })).entries.length, 1);
});

test('find: subsequence and suffix modes, files and directories, every name for an empty query', async t => {
  const { root } = await workspace(t);
  for (const file of ['README.md', 'docs/intro.md', 'docs/guide/intro.md', 'docs/guide/introduction.md', 'src/server.ts', 'src/deep/server-utils.ts', 'Sửa lỗi/ghi chú.md']) await put(path.join(root, file), 'x');
  const page = createFindPages();
  const find = params => allPages(page, root, params);
  assert.deepEqual((await find({})).map(entry => entry.path), ['README.md', 'Sửa lỗi/ghi chú.md', 'docs/guide/intro.md', 'docs/guide/introduction.md', 'docs/intro.md', 'src/deep/server-utils.ts', 'src/server.ts']);
  assert.deepEqual(await find({ kinds: ['directory'] }), [{ path: 'Sửa lỗi', kind: 'directory' }, { path: 'docs', kind: 'directory' }, { path: 'docs/guide', kind: 'directory' }, { path: 'src', kind: 'directory' }, { path: 'src/deep', kind: 'directory' }]);
  assert.deepEqual((await find({ query: 'SRV', kinds: ['file', 'directory'] })).map(entry => entry.path), ['src/deep/server-utils.ts', 'src/server.ts'], 'letters in order, without case');
  assert.deepEqual((await find({ query: 'dgi', kinds: ['directory', 'file'] })).map(entry => entry.path), ['docs/guide', 'docs/guide/intro.md', 'docs/guide/introduction.md']);
  assert.deepEqual((await find({ query: './sửa', kinds: ['directory'] })).map(entry => entry.path), ['Sửa lỗi'], 'a leading ./ is not part of the name; Unicode case folded');
  assert.deepEqual((await find({ query: 'intro.md', matchMode: 'suffix' })).map(entry => entry.path), ['docs/guide/intro.md', 'docs/intro.md'], 'a whole last segment, not a part of one');
  assert.deepEqual((await find({ query: 'GUIDE/intro.md', matchMode: 'suffix' })).map(entry => entry.path), ['docs/guide/intro.md']);
  assert.deepEqual((await find({ query: 'guide', matchMode: 'suffix', kinds: ['directory'] })).map(entry => entry.path), ['docs/guide']);
  assert.deepEqual(await find({ query: 'zzz' }), []);
});

test('find lists a repository as git ls-files does: dot names, deep paths, internal links; never ignored, blocked or outside', { skip: noGit }, async t => {
  const { root, outside } = await workspace(t);
  repo(root);
  await put(path.join(outside, 'secret.ts'), 'SENTINEL');
  const deep = `${Array.from({ length: 20 }, (_, index) => `l${index}`).join('/')}/deep.ts`;
  for (const file of ['.gitignore', '.eslintrc.json', '.github/workflows/ci.yml', 'dist/app.js', 'vendor/lib.js', 'src/a.ts', 'ignored/x.ts', deep, '.env', 'id_rsa', 'node_modules/pkg/index.js']) await put(path.join(root, file), file === '.gitignore' ? 'ignored/\nnode_modules/\n' : 'x');
  await symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'inside-link.ts'));
  await symlink(path.join(root, 'src'), path.join(root, 'src-link'));
  await symlink(path.join(outside, 'secret.ts'), path.join(root, 'outside-link.ts'));
  await symlink(path.join(root, '.env'), path.join(root, 'env-link'));
  const found = await findWorkspaceEntries(root, { kinds: ['file', 'directory'] });
  const paths = found.entries.map(entry => entry.path);
  for (const expected of ['.gitignore', '.eslintrc.json', '.github/workflows/ci.yml', 'dist/app.js', 'vendor/lib.js', 'src/a.ts', deep, 'inside-link.ts', 'src-link']) assert.ok(paths.includes(expected), expected);
  for (const absent of ['ignored', 'ignored/x.ts', 'node_modules', '.env', 'id_rsa', '.git', 'outside-link.ts', 'env-link', 'src-link/a.ts']) assert.ok(!paths.includes(absent), absent);
  assert.ok(!paths.some(entry => entry.startsWith('.git/')));
  assert.deepEqual(found.entries.find(entry => entry.path === 'src-link'), { path: 'src-link', kind: 'directory' }, 'a link is listed as what it leads to, never entered');
  assert.equal(found.truncated, undefined);
  // Search keeps its own, smaller walk.
  assert.deepEqual((await searchWorkspaceFiles(root, { query: 'deep.ts' })).files, []);
});

test('find outside a repository skips what the Paseo bridge skipped: dot names and heavy folders', async t => {
  const { root } = await workspace(t);
  for (const file of ['.hidden.md', '.config/a.md', 'node_modules/a.md', 'Library/a.md', 'dist/a.md', 'build/a.md', 'target/a.md', 'venv/a.md', '__pycache__/a.md', 'vendor/a.md', 'out/a.md', 'src/a.md']) await put(path.join(root, file), 'x');
  const paths = (await findWorkspaceEntries(root, { kinds: ['file', 'directory'] })).entries.map(entry => entry.path);
  assert.deepEqual(paths, ['out', 'out/a.md', 'src', 'src/a.md', 'vendor', 'vendor/a.md']);
});

test('find fails closed when Git cannot say what is ignored', { skip: noFakeGit }, async t => {
  const { root } = await workspace(t);
  repo(root);
  await put(path.join(root, 'a.ts'), 'x');
  const { binary } = await fakeGit(t, 'process.exit(128);');
  assert.deepEqual(await findWorkspaceEntries(root, { git: { binary } }), { entries: [], truncated: true });
  await assert.rejects(findWorkspaceEntries('relative'), /absolute/);
  await assert.rejects(findWorkspaceEntries(path.join(root, 'a.ts')), /not a directory/);
});

test('list: pages past maxListEntries with nextCursor, each entry once; a cursor alpd did not give is refused', async t => {
  const { root } = await workspace(t);
  await mkdir(path.join(root, 'many'));
  const total = WORKSPACE_FILES.maxListEntries * 2 + 5;
  for (let index = 0; index < total; index++) await writeFile(path.join(root, 'many', `f${String(index).padStart(4, '0')}.txt`), '');
  await mkdir(path.join(root, 'many', 'zz-dir'));
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const listed = await listWorkspaceDirectory(root, { path: 'many', ...(cursor ? { cursor } : {}) });
    assert.ok(listed.entries.length <= WORKSPACE_FILES.maxListEntries);
    assert.equal(listed.truncated, listed.nextCursor ? true : undefined);
    seen.push(...listed.entries.map(entry => entry.path));
    cursor = listed.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(seen.length, total + 1);
  assert.equal(new Set(seen).size, total + 1);
  assert.equal(seen[0], 'many/zz-dir', 'directories first, across pages too');
  for (const bad of ['x', Buffer.from('[2,"a"]').toString('base64url'), Buffer.from('[1,""]').toString('base64url')]) {
    assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'many', cursor: bad }), root), { code: -32602, reason: 'invalid_cursor' }, bad);
  }
});

test('internal links: listed and read through as what they lead to inside the workspace; outside, blocked or ignored never', { skip: noGit }, async t => {
  const { root, outside } = await workspace(t);
  repo(root);
  await put(path.join(root, '.gitignore'), 'private/\n');
  await put(path.join(outside, 'secret.txt'), 'SENTINEL-outside');
  await put(path.join(outside, 'notes.md'), 'SENTINEL-outside');
  await put(path.join(root, 'real', 'ok.txt'), 'ok');
  await put(path.join(root, 'private', 'p.txt'), 'SENTINEL-ignored');
  await put(path.join(root, '.env'), 'SENTINEL-env');
  await symlink(path.join(root, 'real'), path.join(root, 'dir-link'));
  await symlink(path.join(root, 'real', 'ok.txt'), path.join(root, 'file-link.txt'));
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'outside-link.txt'));
  await symlink(outside, path.join(root, 'outside-dir'));
  await symlink(path.join(root, '.env'), path.join(root, 'env-link'));
  await symlink(path.join(root, 'private'), path.join(root, 'private-link'));
  await symlink('missing', path.join(root, 'dangling'));
  const listed = await listWorkspaceDirectory(root, { internalLinks: true });
  const byName = Object.fromEntries(listed.entries.map(({ modifiedAt, ...entry }) => [entry.name, entry]));
  assert.deepEqual(byName['dir-link'], { name: 'dir-link', path: 'dir-link', kind: 'directory', target: 'real' });
  assert.deepEqual(byName['file-link.txt'], { name: 'file-link.txt', path: 'file-link.txt', kind: 'file', size: 2, target: 'real/ok.txt' });
  for (const absent of ['outside-link.txt', 'outside-dir', 'env-link', 'private-link', 'private', 'dangling', '.env']) assert.ok(!byName[absent], absent);
  assert.ok(!JSON.stringify(listed).includes(outside));
  // Without internalLinks nothing changes: links are neither listed nor followed.
  assert.ok(!(await listWorkspaceDirectory(root)).entries.some(entry => entry.name.includes('link')));
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'dir-link' }), root), { code: 1003, reason: 'linked' });
  // Through a link: the directory it leads to, named as target; its entries under their real path.
  const through = await listWorkspaceDirectory(root, { path: 'dir-link', internalLinks: true });
  assert.deepEqual([through.target, through.entries.map(entry => entry.path)], ['real', ['real/ok.txt']]);
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'outside-dir', internalLinks: true }), root), { code: 1003, reason: 'outside' });
  assert.deepEqual(await refusal(listWorkspaceDirectory(root, { path: 'private-link', internalLinks: true }), root), { code: 1003, reason: 'ignored' });
  assert.equal((await listWorkspaceDirectory(root, { path: 'private-link', internalLinks: true, includeIgnored: true })).target, 'private');
  const read = await previewWorkspaceFile(root, { path: 'file-link.txt', internalLinks: true });
  assert.deepEqual([read.path, read.target, Buffer.from(read.content, 'base64').toString()], ['file-link.txt', 'real/ok.txt', 'ok']);
  assert.equal((await previewWorkspaceFile(root, { path: 'dir-link/ok.txt', internalLinks: true })).target, 'real/ok.txt');
  for (const [file, reason] of [['outside-link.txt', 'outside'], ['outside-dir/notes.md', 'outside'], ['env-link', 'blocked_path'], ['private-link/p.txt', 'ignored'], ['dangling', 'not_found'], ['dir-link', 'not_found']]) {
    assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: file, internalLinks: true }), root), { code: reason === 'not_found' ? 1001 : 1003, reason }, file);
  }
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'file-link.txt' }), root), { code: 1003, reason: 'linked' }, 'only with internalLinks');
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('preview: text, JSON, images and binaries as the Files panel shows them; refusals as read', async t => {
  const { root, outside } = await workspace(t);
  await put(path.join(root, 'docs', 'sửa lỗi.md'), '﻿# Tiêu đề\n');
  await put(path.join(root, 'data.json'), '{"a":1}');
  await put(path.join(root, 'dot.png'), PNG);
  await put(path.join(root, 'logo.svg'), '<svg/>');
  await put(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  await put(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await put(path.join(root, 'control.txt'), Buffer.alloc(100, 1));
  await put(path.join(root, 'empty.txt'), '');
  await put(path.join(root, 'id.txt'), 'note\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n');
  await put(path.join(root, 'key.png'), Buffer.concat([PNG, Buffer.from('-----BEGIN RSA PRIVATE KEY-----')]));
  await put(path.join(root, '.env'), 'SENTINEL');
  await put(path.join(outside, 'secret.txt'), 'SENTINEL-outside');
  await link(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'));
  const preview = file => previewWorkspaceFile(root, { path: file });
  const text = await preview('docs/sửa lỗi.md');
  const bytes = Buffer.from('﻿# Tiêu đề\n');
  assert.deepEqual({ ...text, modifiedAt: typeof text.modifiedAt, revision: typeof text.revision }, { path: 'docs/sửa lỗi.md', kind: 'text', mimeType: 'text/plain', size: bytes.length, modifiedAt: 'string', revision: 'string', encoding: 'base64', content: bytes.toString('base64'), offset: 0 });
  assert.deepEqual([(await preview('data.json')).mimeType, (await preview('empty.txt')).content], ['application/json', '']);
  const image = await preview('dot.png');
  assert.deepEqual([image.kind, image.mimeType, image.content], ['image', 'image/png', PNG.toString('base64')]);
  assert.deepEqual([(await preview('logo.svg')).kind, (await preview('logo.svg')).mimeType], ['image', 'image/svg+xml']);
  for (const file of ['blob.bin', 'latin1.txt', 'control.txt']) {
    const binary = await preview(file);
    assert.deepEqual([binary.kind, binary.encoding, binary.mimeType, binary.content, binary.nextOffset], ['binary', 'none', 'application/octet-stream', undefined, undefined], file);
  }
  for (const [file, code, reason] of [['id.txt', 1003, 'blocked_path'], ['key.png', 1003, 'blocked_path'], ['.env', 1003, 'blocked_path'], ['hard.txt', 1003, 'linked'], ['missing.txt', 1001, 'not_found'], ['docs', 1001, 'not_found'], ['../outside/secret.txt', -32602, 'invalid_path']]) {
    assert.deepEqual(await refusal(preview(file), root), { code, reason }, file);
  }
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'data.json', maxBytes: 3 }), root), { code: 1000, reason: 'too_large' });
});

test('preview: a large file comes in chunks of one revision; a change between chunks is refused; at most maxPreviewBytes', async t => {
  const { root } = await workspace(t);
  const size = WORKSPACE_FILES.maxPreviewChunkBytes * 2 + 123;
  const body = Buffer.alloc(size, 'abcdefghij');
  await put(path.join(root, 'big.log'), body);
  const first = await previewWorkspaceFile(root, { path: 'big.log' });
  assert.deepEqual([first.kind, first.size, first.offset, first.nextOffset], ['text', size, 0, WORKSPACE_FILES.maxPreviewChunkBytes]);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 16 * 1024 * 1024, 'a chunk fits one frame');
  const chunks = [Buffer.from(first.content, 'base64')];
  for (let offset = first.nextOffset; offset !== undefined;) {
    const chunk = await previewWorkspaceFile(root, { path: 'big.log', offset, revision: first.revision });
    assert.equal(chunk.revision, first.revision);
    chunks.push(Buffer.from(chunk.content, 'base64'));
    offset = chunk.nextOffset;
  }
  assert.equal(chunks.length, 3);
  assert.ok(Buffer.concat(chunks).equals(body));
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'big.log', offset: first.nextOffset }), root), { code: -32602, reason: 'invalid_params' }, 'a later chunk needs the revision');
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'big.log', offset: size, revision: first.revision }), root), { code: -32602, reason: 'invalid_params' });
  // A binary file's revision does not read it as text.
  await put(path.join(root, 'blob.bin'), Buffer.concat([Buffer.from([0]), body]));
  const binary = await previewWorkspaceFile(root, { path: 'blob.bin' });
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'blob.bin', offset: 1, revision: binary.revision }), root), { code: 1004, reason: 'changed' });
  await writeFile(path.join(root, 'big.log'), Buffer.concat([body, Buffer.from('more')]));
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'big.log', offset: first.nextOffset, revision: first.revision }), root), { code: 1004, reason: 'changed' });
  // A private key past the first chunk refuses the whole text file.
  await put(path.join(root, 'late-key.txt'), Buffer.concat([body, Buffer.from('-----BEGIN PRIVATE KEY-----')]));
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'late-key.txt' }), root), { code: 1003, reason: 'blocked_path' });
  // The cap: 50 MiB, whatever maxBytes asks.
  const huge = path.join(root, 'huge.bin');
  await writeFile(huge, '');
  await truncate(huge, WORKSPACE_FILES.maxPreviewBytes + 1);
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'huge.bin', maxBytes: WORKSPACE_FILES.maxPreviewBytes * 2 }), root), { code: 1000, reason: 'too_large' });
  await truncate(huge, WORKSPACE_FILES.maxPreviewBytes);
  const capped = await previewWorkspaceFile(root, { path: 'huge.bin' });
  assert.deepEqual([capped.kind, capped.size, capped.content], ['binary', WORKSPACE_FILES.maxPreviewBytes, undefined]);
});

test('preview: .gitignore\'d files only with includeIgnored, and a race on the file is refused', { skip: noGit }, async t => {
  const { root, outside } = await workspace(t);
  repo(root);
  await put(path.join(root, '.gitignore'), 'out/\n');
  await put(path.join(root, 'out', 'app.js'), 'compiled');
  await put(path.join(root, 'a.txt'), 'inside');
  await put(path.join(outside, 'secret.txt'), 'SENTINEL-outside');
  assert.deepEqual(await refusal(previewWorkspaceFile(root, { path: 'out/app.js' }), root), { code: 1003, reason: 'ignored' });
  assert.equal(Buffer.from((await previewWorkspaceFile(root, { path: 'out/app.js', includeIgnored: true })).content, 'base64').toString(), 'compiled');
  const swapped = await refusal(previewWorkspaceFile(root, { path: 'a.txt', probe: async step => {
    if (step !== 'read') return;
    await rename(path.join(root, 'a.txt'), path.join(root, 'a.old'));
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'a.txt'));
  } }), root);
  assert.deepEqual(swapped, { code: 1003, reason: 'linked' });
});

test('host directories: a typed path completes in its parent, a word is found under home, nearest and best first; links never', async t => {
  const { root: home, outside } = await workspace(t);
  for (const directory of ['Code/alp', 'Code/alpha', 'Code/Alpine', 'Code/.alp-hidden', 'Code/other', 'work/clients/alp', 'work/alp-tools', 'node_modules/alp', '.cache/alp', 'Library/alp', 'deep/a/b/c/alp']) await mkdir(path.join(home, directory), { recursive: true });
  await put(path.join(home, 'Code', 'alp.txt'), 'a file');
  await symlink(outside, path.join(home, 'Code', 'alp-link'));
  const search = (query, options = {}) => searchHostDirectories(query, { home, ...options }).then(result => result.entries.map(entry => entry.path));
  const code = names => names.map(name => path.join(home, 'Code', name));
  assert.deepEqual(await search(`${home}/Code/al`), code(['alp', 'alpha', 'Alpine']), 'by name, links and files left out');
  assert.deepEqual(await search('~/Code/AL'), code(['alp', 'alpha', 'Alpine']), 'under ~, without case');
  assert.deepEqual(await search('~/Code/.al'), code(['.alp-hidden']), 'dot names only when asked');
  assert.deepEqual(await search('~/Code/'), code(['alp', 'alpha', 'Alpine', 'other']));
  assert.deepEqual(await search('~/Code/al', { limit: 1 }), code(['alp']));
  assert.deepEqual(await search('/no/such/dir/x'), []);
  assert.deepEqual(await search('alp'), [path.join(home, 'Code', 'alp'), path.join(home, 'work', 'clients', 'alp'), path.join(home, 'Code', 'alpha'), path.join(home, 'Code', 'Alpine'), path.join(home, 'work', 'alp-tools')], 'equal, then starts with; nearer first; heavy, hidden and deeper than 4 levels left out');
  assert.deepEqual(await search('ohr'), code(['other']), 'letters in order');
  assert.deepEqual(await search('   '), []);
  assert.deepEqual(await search(42), []);
});
