// The Paseo bridge's file features answered by alpd (t-bb87, docs/protocol/alp-json-rpc-v1.md
// §12.11) against the local backend they replaced, kept below verbatim as the oracle: the same
// suggestions in the same order, the same Files panel answers, over a real alpd in this process.
// Where they differ on purpose (alpd's block list, links that lead outside) the test says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { fakeTransport } from '../../../test/support/fake-agent.js';
import { directorySuggestions, fileExplorer } from '../server/dist/paseo/files.js';

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// ---- The local backend as it was (integrations/paseo/server/paseo/files.ts before t-bb87) ----

const SKIPPED = new Set(['node_modules', 'Library', '.git', 'dist', 'build', '.cache', 'target', '.venv', 'venv', '__pycache__']);
const HOME_SCAN_LIMIT = 5_000;
const HOME_DEPTH = 4;
const WORKSPACE_SCAN_LIMIT = 20_000;
const children = directory => readdir(directory, { withFileTypes: true }).catch(() => []);
const expand = query => query === '~' ? os.homedir() : query.startsWith('~/') ? path.join(os.homedir(), query.slice(2)) : query;
function rank(candidate, query) {
  const name = candidate.toLowerCase();
  const wanted = query.toLowerCase();
  if (name === wanted) return 0;
  if (name.startsWith(wanted)) return 1;
  if (name.includes(wanted)) return 2;
  let at = 0;
  for (const char of name) if (char === wanted[at]) at += 1;
  return at === wanted.length ? 3 : undefined;
}
async function pathCompletions(query, limit) {
  const typed = expand(query.trim());
  const folder = typed.endsWith('/') || typed.endsWith(path.sep);
  const parent = folder ? typed : path.dirname(typed);
  const prefix = folder ? '' : path.basename(typed).toLowerCase();
  return (await children(parent))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix) && (!entry.name.startsWith('.') || prefix.startsWith('.')))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, limit)
    .map(name => ({ path: path.join(parent, name), kind: 'directory' }));
}
async function homeSearch(query, limit) {
  const found = [];
  let queue = [os.homedir()];
  let scanned = 0;
  for (let depth = 1; depth <= HOME_DEPTH && queue.length && scanned < HOME_SCAN_LIMIT; depth += 1) {
    const next = [];
    for (const directory of queue) {
      for (const entry of await children(directory)) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        scanned += 1;
        const score = rank(entry.name, query);
        if (score !== undefined) found.push({ path: full, score, depth });
        next.push(full);
        if (scanned >= HOME_SCAN_LIMIT) break;
      }
      if (scanned >= HOME_SCAN_LIMIT) break;
    }
    queue = next;
  }
  return found.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, limit).map(entry => ({ path: entry.path, kind: 'directory' }));
}
async function workspaceEntries(root) {
  let listed;
  try { listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { listed = undefined; }
  if (listed !== undefined) {
    const files = listed.split('\0').filter(Boolean).slice(0, WORKSPACE_SCAN_LIMIT);
    const directories = new Set();
    for (const file of files) for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
    return [...[...directories].map(dir => ({ path: dir, kind: 'directory' })), ...files.map(file => ({ path: file, kind: 'file' }))];
  }
  const entries = [];
  const walk = async relative => {
    for (const entry of await children(path.join(root, relative))) {
      if (entries.length >= WORKSPACE_SCAN_LIMIT) return;
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { entries.push({ path: child, kind: 'directory' }); await walk(child); }
      else if (entry.isFile()) entries.push({ path: child, kind: 'file' });
    }
  };
  await walk('');
  return entries;
}
async function legacyWorkspaceSearch(message, root, limit) {
  const wantFiles = message.includeFiles === true;
  const wantDirectories = message.includeDirectories !== false;
  const keep = entry => entry.kind === 'file' ? wantFiles : wantDirectories;
  const query = message.query.trim().replace(/^\.\//, '');
  if (!query) {
    return (await children(root)).filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({ path: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })).filter(keep)
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
  }
  const all = (await workspaceEntries(root)).filter(keep);
  if (message.matchMode === 'suffix') {
    const wanted = query.toLowerCase();
    return all.filter(entry => entry.path.toLowerCase() === wanted || entry.path.toLowerCase().endsWith(`/${wanted}`)).sort((a, b) => a.path.length - b.path.length).slice(0, limit);
  }
  return all.map(entry => {
    const byName = rank(path.posix.basename(entry.path), query);
    const byPath = rank(entry.path, query);
    return { entry, score: byName ?? (byPath === undefined ? undefined : byPath + 4) };
  }).filter(row => row.score !== undefined)
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit).map(row => row.entry);
}
async function legacySuggestions(message) {
  const limit = message.limit ?? 30;
  const cwd = message.cwd?.trim();
  const query = message.query.trim();
  const entries = cwd ? await legacyWorkspaceSearch(message, path.resolve(expand(cwd)), limit)
    : !query ? [] : path.isAbsolute(query) || query.startsWith('~') ? await pathCompletions(query, limit) : await homeSearch(query, limit);
  return { requestId: message.requestId, directories: entries.filter(entry => entry.kind === 'directory').map(entry => entry.path), entries, error: null };
}
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
async function inside(root, relative) {
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, relative || '.');
  const real = await realpath(target);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Access outside of workspace is not allowed');
  return { realRoot, real, target };
}
const posixRelative = (root, target) => path.relative(root, target).split(path.sep).join('/') || '.';
function textOf(buffer) {
  if (buffer.includes(0)) return undefined;
  let control = 0;
  const head = buffer.subarray(0, 16 * 1024);
  for (const byte of head) if (byte < 9 || (byte > 13 && byte < 32)) control++;
  if (head.length && control / head.length > 0.3) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return undefined; }
}
async function legacyExplorer(message) {
  const reply = fields => ({ requestId: message.requestId, cwd: message.cwd, path: message.path ?? '.', mode: message.mode, directory: null, file: null, error: null, ...fields });
  try {
    const root = path.resolve(expand(message.cwd));
    const { realRoot, real, target } = await inside(root, message.path ?? '.');
    const relative = posixRelative(realRoot, real);
    if (message.mode === 'list') {
      const entries = [];
      for (const entry of await readdir(real, { withFileTypes: true })) {
        const child = path.join(real, entry.name);
        const resolved = entry.isSymbolicLink() ? await inside(realRoot, path.relative(realRoot, child)).then(found => found.real, () => undefined) : child;
        if (!resolved) continue;
        const info = await stat(resolved).catch(() => undefined);
        if (!info) continue;
        entries.push({ name: entry.name, path: posixRelative(realRoot, child), kind: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() });
      }
      entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return reply({ path: relative, directory: { path: relative, entries } });
    }
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`${posixRelative(root, target)} is not a file`);
    if (info.size > (message.maxBytes ?? 50 * 1024 * 1024)) throw new Error('File is too large to display');
    const buffer = await readFile(real);
    const base = { path: relative, size: info.size, modifiedAt: info.mtime.toISOString(), revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
    const image = IMAGES[path.extname(real).toLowerCase()];
    if (image) return reply({ path: relative, file: { ...base, kind: 'image', encoding: 'base64', content: buffer.toString('base64'), mimeType: image } });
    const text = textOf(buffer);
    if (text === undefined) return reply({ path: relative, file: { ...base, kind: 'binary', encoding: 'none', mimeType: 'application/octet-stream' } });
    return reply({ path: relative, file: { ...base, kind: 'text', encoding: 'utf-8', content: text, mimeType: path.extname(real).toLowerCase() === '.json' ? 'application/json' : 'text/plain' } });
  } catch (error) {
    return reply({ error: error?.code === 'ENOENT' ? 'No such file or directory' : error?.message ?? String(error) });
  }
}

// ---- alpd behind the bridge ----

async function alpd(t) {
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  const client = daemon.local();
  t.after(async () => { client.close(); await runtime.shutdown(); });
  return (method, params) => client.request(method, params);
}

async function tree(t, files, { git = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-files-parity-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  if (git) execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

const DEEP = `${'abcdefghijklmn'.split('').join('/')}/deep-notes.md`;
const WORKSPACE = {
  'README.md': '# Read me', 'docs/intro.md': 'x', 'docs/guide/intro.md': 'x', 'docs/guide/introduction.md': 'x', 'docs/Guide.md': 'x',
  'src/server.ts': 'x', 'src/deep/server-utils.ts': 'x', 'src/index.ts': 'x', 'src/a.generated.ts': 'x', '.github/workflows/ci.yml': 'x', '.eslintrc.json': '{}',
  '.gitignore': 'node_modules/\ndist/\n*.log\n*.generated.ts\n', 'node_modules/pkg/index.js': 'x', 'dist/app.js': 'x', 'debug.log': 'x',
  [DEEP]: 'x', 'Sửa lỗi/ghi chú.md': 'x', 'assets/logo.png': 'x', 'vendor/lib/intro.js': 'x', 'out/server.js': 'x',
};
const QUERIES = ['intro', 'server', 'srv', 'guide', 'ci', 'readme', 'deep', 'sửa', 'md', 'a/b', 'logo', 'INDEX', './src', 'gen', 'zzz'];
const SUFFIXES = ['intro.md', 'guide/intro.md', 'ci.yml', 'README.md', 'deep-notes.md', 'server.ts'];
const SHAPES = [{ includeFiles: true, includeDirectories: false }, { includeFiles: false, includeDirectories: true }, { includeFiles: true, includeDirectories: true }, {}];

async function sameSuggestions(rpc, root) {
  let compared = 0;
  for (const shape of SHAPES) {
    for (const [query, matchMode] of [...QUERIES.map(query => [query]), ...SUFFIXES.map(query => [query, 'suffix']), ['']]) {
      for (const limit of [30, 3]) {
        const message = { type: 'directory_suggestions_request', requestId: 'p', cwd: root, query, ...shape, ...(matchMode ? { matchMode } : {}), limit };
        assert.deepEqual((await directorySuggestions(message, rpc)).payload, await legacySuggestions(message), JSON.stringify(message));
        compared++;
      }
    }
  }
  return compared;
}

test('workspace suggestions: every query, mode and shape answers as the local backend did, in a repository', { skip: !hasGit && 'git is not installed' }, async t => {
  const rpc = await alpd(t);
  const root = await tree(t, WORKSPACE, { git: true });
  await symlink(path.join(root, 'README.md'), path.join(root, 'readme-link.md'));
  assert.equal(await sameSuggestions(rpc, root), SHAPES.length * (QUERIES.length + SUFFIXES.length + 1) * 2);
  // Deeper than workspace.files.search walks (12 levels), as git ls-files lists it.
  const deep = await directorySuggestions({ type: 'directory_suggestions_request', requestId: 'd', cwd: root, query: 'deep-notes', includeFiles: true, includeDirectories: false }, rpc);
  assert.deepEqual(deep.payload.entries, [{ path: DEEP, kind: 'file' }]);
});

test('workspace suggestions outside a repository answer as the local walk did', async t => {
  const rpc = await alpd(t);
  const root = await tree(t, { ...WORKSPACE, '.hidden/x.md': 'x', 'build/intro.md': 'x', 'target/intro.md': 'x', 'Library/intro.md': 'x' });
  assert.ok(await sameSuggestions(rpc, root) > 0);
});

test('more names than one page: the complete set is ranked, as the local backend ranked it', { skip: !hasGit && 'git is not installed' }, async t => {
  const rpc = await alpd(t);
  const files = {};
  for (let index = 0; index < 2600; index++) files[`pkg${index % 13}/mod${String(index).padStart(4, '0')}.ts`] = 'x';
  files['zz/last/mod.ts'] = 'x';
  const root = await tree(t, files, { git: true });
  const calls = [];
  const counted = (method, params) => { calls.push(method); return rpc(method, params); };
  for (const query of ['mod', 'mod.ts', 'zz', 'pkg12/mod2599']) {
    const message = { type: 'directory_suggestions_request', requestId: 'm', cwd: root, query, includeFiles: true, includeDirectories: true, limit: 100 };
    assert.deepEqual((await directorySuggestions(message, counted)).payload, await legacySuggestions(message), query);
  }
  assert.ok(calls.length > 4, 'the bridge read more than one page');
});

test('host folders: typed paths and names under home answer as the local backend did', async t => {
  const rpc = await alpd(t);
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-files-parity-home-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const directory of ['Code/alp', 'Code/alpha', 'Code/Alpine', 'Code/.alp-hidden', 'Code/other', 'work/clients/alp', 'work/alp-tools', 'node_modules/alp', '.cache/alp', 'Library/alp', 'deep/a/b/c/alp', 'Documents/Notes']) await mkdir(path.join(home, directory), { recursive: true });
  await writeFile(path.join(home, 'Code', 'alp.txt'), 'x');
  await symlink(path.join(home, 'work'), path.join(home, 'Code', 'alp-link'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
  assert.equal(os.homedir(), home);
  for (const query of ['alp', 'ALP', 'ohr', 'notes', 'zzz', '~', '~/', '~/Code/al', '~/Code/', '~/Code/.a', `${home}/Code/AL`, `${home}/work/`, '/no/such/dir/x', '']) {
    for (const limit of [30, 2]) {
      const message = { type: 'directory_suggestions_request', requestId: 'h', query, limit };
      assert.deepEqual((await directorySuggestions(message, rpc)).payload, await legacySuggestions(message), `${query} ${limit}`);
    }
  }
});

test('the Files panel: listings and text, image, binary and large files answer as the local backend did; blocked paths never', { skip: !hasGit && 'git is not installed' }, async t => {
  const rpc = await alpd(t);
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-files-parity-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'notes.md'), 'SENTINEL-outside');
  const root = await tree(t, {
    'README.md': '# Read me\n', 'bom.md': '﻿with a BOM\n', 'data.json': '{"a":1}', 'dot.png': Buffer.from('89504e470d0a1a0a', 'hex'), 'logo.svg': '<svg/>',
    'blob.bin': Buffer.from([1, 2, 0, 3]), 'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'control.txt': Buffer.alloc(100, 1), 'empty.txt': '',
    'big.log': Buffer.alloc(20 * 1024 * 1024 + 7, 'lorem ipsum\n'), 'docs/guide.md': '# Guide\n', 'docs/sub/x.md': 'x', 'dist/out.js': 'built', '.gitignore': 'dist/\n', '.env': 'SENTINEL-env',
  }, { git: true });
  await symlink(path.join(root, 'docs'), path.join(root, 'docs-link'));
  await symlink(path.join(root, 'docs', 'guide.md'), path.join(root, 'guide-link.md'));
  await symlink(path.join(outside, 'notes.md'), path.join(root, 'outside-link.md'));
  await symlink(outside, path.join(root, 'outside-dir'));
  // Distinct times: both sort a listing by them, newest first (a link has its target's).
  let second = 0;
  for (const name of await readdir(root)) await utimes(path.join(root, name), new Date(Date.UTC(2026, 0, 1, 0, 0, ++second)), new Date(Date.UTC(2026, 0, 1, 0, 0, second)));
  for (const name of await readdir(path.join(root, 'docs'))) await utimes(path.join(root, 'docs', name), new Date(Date.UTC(2026, 0, 2, 0, 0, ++second)), new Date(Date.UTC(2026, 0, 2, 0, 0, second)));
  const ask = async message => {
    const full = { type: 'file_explorer_request', requestId: 'x', cwd: root, ...message };
    return [(await fileExplorer(full, rpc)).payload, await legacyExplorer(full)];
  };
  // alpd's block list is a floor the local backend did not have: .git and .env are never listed.
  const BLOCKED = new Set(['.git', '.env']);
  // A directory's own size means nothing (alpd answers 0); entries of one time (a link and its target) in any order.
  const comparable = entries => entries.map(entry => entry.kind === 'directory' ? { ...entry, size: 'directory' } : entry).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  for (const listed of ['.', 'docs', 'docs-link', 'dist']) {
    const [now, before] = await ask({ path: listed, mode: 'list' });
    assert.deepEqual(now.directory.entries.map(entry => entry.modifiedAt), [...now.directory.entries.map(entry => entry.modifiedAt)].sort().reverse(), 'newest first');
    assert.deepEqual({ ...now, directory: { ...now.directory, entries: comparable(now.directory.entries) } },
      { ...before, directory: { ...before.directory, entries: comparable(before.directory.entries.filter(entry => !BLOCKED.has(entry.name))) } }, listed);
  }
  const [root0] = await ask({ path: '.', mode: 'list' });
  assert.ok(!root0.directory.entries.some(entry => BLOCKED.has(entry.name) || entry.name.startsWith('outside')), 'neither blocked names nor links that lead outside');
  for (const file of ['README.md', 'bom.md', 'data.json', 'dot.png', 'logo.svg', 'blob.bin', 'latin1.txt', 'control.txt', 'empty.txt', 'big.log', 'docs/guide.md', 'docs-link/guide.md', 'guide-link.md', 'dist/out.js']) {
    const [now, before] = await ask({ path: file, mode: 'file' });
    assert.equal(typeof now.file?.revision, 'string', file);
    assert.deepEqual({ ...now, file: { ...now.file, revision: 'r' } }, { ...before, file: { ...before.file, revision: 'r' } }, file);
  }
  for (const message of [{ path: 'README.md', mode: 'file', maxBytes: 3 }, { path: 'missing.md', mode: 'file' }, { path: 'missing', mode: 'list' }, { path: path.relative(root, outside), mode: 'list' }, { path: 'outside-link.md', mode: 'file' }, { path: 'outside-dir', mode: 'list' }]) {
    const [now, before] = await ask(message);
    assert.deepEqual(now, before, JSON.stringify(message));
  }
  // What the local backend gave and alpd refuses: blocked paths, whatever their content.
  const [env, legacyEnv] = await ask({ path: '.env', mode: 'file' });
  assert.equal(legacyEnv.file.content, 'SENTINEL-env');
  assert.deepEqual([env.file, typeof env.error], [null, 'string']);
  assert.ok(!JSON.stringify(env).includes('SENTINEL'));
});
