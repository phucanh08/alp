// host.workspace.facts (t-ff83, src/dashboard/owner/workspace-facts.js): branch, diff against the
// base branch, PR and CI from a fake gh first on PATH, and a logo file, for the registry's
// workspaces only; fail soft per field; bounded by its cache, in-flight reads and concurrency.
// No test reaches the network: PATH holds only a link to git and (when a test wants one) a fake gh,
// and GH_CONFIG_DIR, HOME point into the scratch directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FACTS, ICON_CANDIDATES, ciOf, createWorkspaceFacts, factsParams, iconOf, isInside, looksLike, onPath, methods, numstat, prOf, readFacts } from '../src/dashboard/owner/workspace-facts.js';
import { teardown } from '../../../test/support/teardown.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n';
const GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const skipGit = process.platform === 'win32' ? 'POSIX shell fake gh' : false;

async function scratch(t) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-owner-facts-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await symlink(GIT, path.join(bin, 'git'));
  const home = path.join(directory, 'home');
  await mkdir(home);
  const env = { PATH: bin, HOME: home, GH_CONFIG_DIR: path.join(home, 'gh'), XDG_CONFIG_HOME: path.join(home, 'xdg') };
  return { directory, bin, env };
}

/** A fake gh (shell builtins only: PATH holds nothing else): prints $FAKE_GH_JSON's file and exits $FAKE_GH_EXIT, logging its args. */
async function fakeGh(bin, directory) {
  const log = path.join(directory, 'gh.log');
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\necho "$PWD $*" >> "$FAKE_GH_LOG"\nif [ -n "$FAKE_GH_JSON" ]; then while IFS= read -r line || [ -n "$line" ]; do printf "%s\\n" "$line"; done < "$FAKE_GH_JSON"; fi\nexit "${FAKE_GH_EXIT:-0}"\n');
  await chmod(path.join(bin, 'gh'), 0o755);
  return log;
}

const git = (cwd, ...args) => execFileSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

/**
 * A repository on branch `feature`: main has a 10-line file, origin/main points at it; feature
 * commits +3/-1, and the work tree adds 1 more line uncommitted and an untracked file.
 */
async function repository(directory, { remote = true } = {}) {
  const repo = path.join(directory, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q');
  await writeFile(path.join(repo, 'a.txt'), Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  if (remote) {
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/owner/repo.git');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  git(repo, 'checkout', '-q', '-b', 'feature');
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  lines[0] = 'changed 0';
  lines.push('new 10', 'new 11');
  await writeFile(path.join(repo, 'a.txt'), lines.join('\n') + '\n');
  git(repo, 'commit', '-q', '-am', 'feature');
  await writeFile(path.join(repo, 'a.txt'), [...lines, 'new 12'].join('\n') + '\n');
  await writeFile(path.join(repo, 'untracked.txt'), 'x\ny\n');
  return repo;
}

test('the pure parts: params, ci, pr, numstat, magic bytes', () => {
  assert.deepEqual(factsParams({ workspaceIds: ['a', 'a', 'b'] }), { workspaceIds: ['a', 'b'] });
  assert.deepEqual(factsParams({ workspaceIds: ['a'], refresh: true }), { workspaceIds: ['a'], refresh: true });
  for (const params of [{}, { workspaceIds: [] }, { workspaceIds: 'a' }, { workspaceIds: [1] }, { workspaceIds: [''] }, { workspaceIds: Array.from({ length: FACTS.maxIds + 1 }, (_, i) => `w${i}`) }, { workspaceIds: ['a'], refresh: 'yes' }])
    assert.throws(() => factsParams(params), error => error.code === -32602, JSON.stringify(params).slice(0, 80));
  assert.doesNotThrow(() => factsParams({ workspaceIds: Array.from({ length: FACTS.maxIds }, (_, i) => `w${i}`) }));

  assert.equal(ciOf(undefined), undefined);
  assert.equal(ciOf([]), undefined);
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'NEUTRAL' }]), 'passed');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(ciOf([{ state: 'PENDING' }]), 'pending');
  assert.equal(ciOf([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failed');
  assert.equal(ciOf([{ state: 'ERROR' }]), 'failed');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'CANCELLED' }]), 'failed');

  assert.deepEqual(prOf({ number: 7, state: 'OPEN', isDraft: false }), { number: 7, state: 'open' });
  assert.deepEqual(prOf({ number: 7, state: 'OPEN', isDraft: true }), { number: 7, state: 'draft' });
  assert.deepEqual(prOf({ number: 7, state: 'MERGED' }), { number: 7, state: 'merged' });
  assert.deepEqual(prOf({ number: 7, state: 'CLOSED' }), { number: 7, state: 'closed' });
  assert.equal(prOf({ number: 'x', state: 'OPEN' }), undefined);
  assert.equal(prOf({ number: 7, state: 'WEIRD' }), undefined);

  assert.deepEqual(numstat('2\t1\ta.txt\n-\t-\tbin.png\n10\t0\tb\n'), { additions: 12, deletions: 1 });
  assert.ok(looksLike('.png', PNG));
  assert.ok(!looksLike('.png', Buffer.from('not a png at all')));
  assert.ok(looksLike('.svg', Buffer.from(SVG)));
  assert.ok(!looksLike('.svg', Buffer.from('hello <svg>')));
  assert.ok(looksLike('.ico', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])));
  assert.ok(!looksLike('.ico', PNG));
});

test('readFacts: branch, diff against the merge-base with origin/main (untracked not counted), PR open with CI passed', { skip: skipGit }, async t => {
  const { directory, bin, env } = await scratch(t);
  const repo = await repository(directory);
  const log = await fakeGh(bin, directory);
  const json = path.join(directory, 'pr.json');
  await writeFile(json, JSON.stringify({ number: 42, state: 'OPEN', isDraft: false, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
  const facts = await readFacts(repo, { env: { ...env, FAKE_GH_JSON: json, FAKE_GH_LOG: log } });
  // Committed +3 -1 (line 0 changed, 2 added), uncommitted +1; untracked.txt is not counted.
  assert.deepEqual(facts, { branch: 'feature', additions: 4, deletions: 1, pr: { number: 42, state: 'open' }, ci: 'passed' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /pr view feature --json number,state,isDraft,statusCheckRollup$/);
  assert.ok(calls[0].startsWith(await import('node:fs/promises').then(fs => fs.realpath(repo))), 'gh runs in the workspace directory');
});

test('readFacts: merged PR with failed CI; draft PR with pending CI; no checks → no ci', { skip: skipGit }, async t => {
  const { directory, bin, env } = await scratch(t);
  const repo = await repository(directory);
  const log = await fakeGh(bin, directory);
  const json = path.join(directory, 'pr.json');
  const read = async view => { await writeFile(json, JSON.stringify(view)); return readFacts(repo, { env: { ...env, FAKE_GH_JSON: json, FAKE_GH_LOG: log } }); };
  let facts = await read({ number: 5, state: 'MERGED', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] });
  assert.deepEqual([facts.pr, facts.ci], [{ number: 5, state: 'merged' }, 'failed']);
  facts = await read({ number: 6, state: 'OPEN', isDraft: true, statusCheckRollup: [{ state: 'PENDING' }] });
  assert.deepEqual([facts.pr, facts.ci], [{ number: 6, state: 'draft' }, 'pending']);
  facts = await read({ number: 7, state: 'CLOSED', isDraft: false, statusCheckRollup: [] });
  assert.deepEqual(facts.pr, { number: 7, state: 'closed' });
  assert.ok(!('ci' in facts));
});

test('readFacts is fail soft: gh failing, gh missing, garbage from gh, no remote, not a repository, no git', { skip: skipGit }, async t => {
  const { directory, bin, env } = await scratch(t);
  const repo = await repository(directory);
  // No gh on PATH: the git facts stay.
  assert.deepEqual(await readFacts(repo, { env }), { branch: 'feature', additions: 4, deletions: 1 });
  // gh fails (not logged in, no PR): no pr, no ci.
  const log = await fakeGh(bin, directory);
  assert.deepEqual(await readFacts(repo, { env: { ...env, FAKE_GH_LOG: log, FAKE_GH_EXIT: '1' } }), { branch: 'feature', additions: 4, deletions: 1 });
  // gh prints something that is not its JSON.
  const json = path.join(directory, 'garbage.json');
  await writeFile(json, 'no pull requests found');
  assert.deepEqual(await readFacts(repo, { env: { ...env, FAKE_GH_LOG: log, FAKE_GH_JSON: json } }), { branch: 'feature', additions: 4, deletions: 1 });
  // No remote: gh is not asked at all, and the diff falls back to main (a local base branch).
  await mkdir(path.join(directory, 'lonely'));
  const lonely = await repository(path.join(directory, 'lonely'), { remote: false });
  const before = (await readFile(log, 'utf8')).split('\n').length;
  assert.deepEqual(await readFacts(lonely, { env: { ...env, FAKE_GH_LOG: log } }), { branch: 'feature', additions: 4, deletions: 1 });
  assert.equal((await readFile(log, 'utf8')).split('\n').length, before, 'no gh without a remote');
  // Not a repository: nothing but what does not need Git.
  const plain = path.join(directory, 'plain');
  await mkdir(plain);
  assert.deepEqual(await readFacts(plain, { env }), {});
  // No git on PATH at all.
  assert.deepEqual(await readFacts(repo, { env: { ...env, PATH: path.join(directory, 'nothing') } }), {});
  // A directory that is gone.
  assert.deepEqual(await readFacts(path.join(directory, 'gone'), { env }), {});
});

test('readFacts: detached HEAD has no branch and asks no gh; a repository without a base branch counts uncommitted changes only', { skip: skipGit }, async t => {
  const { directory, bin, env } = await scratch(t);
  const repo = await repository(directory);
  const log = await fakeGh(bin, directory);
  git(repo, 'checkout', '-q', '--detach');
  const facts = await readFacts(repo, { env: { ...env, FAKE_GH_LOG: log } });
  assert.equal(facts.branch, undefined);
  assert.equal(facts.pr, undefined);
  assert.equal(facts.additions, 4);
  await assert.rejects(readFile(log, 'utf8'), 'gh never ran');
  // A repository whose only branch is not a base branch: uncommitted vs HEAD.
  const other = path.join(directory, 'other');
  await mkdir(other);
  git(other, 'init', '-q', '-b', 'trunk');
  await writeFile(path.join(other, 'f'), 'a\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'one');
  await writeFile(path.join(other, 'f'), 'b\nc\n');
  assert.deepEqual(await readFacts(other, { env }), { branch: 'trunk', additions: 2, deletions: 1 });
});

test('readFacts: a filter driver, fsmonitor and hooks the repository configures never run', { skip: skipGit }, async t => {
  const { directory, env } = await scratch(t);
  const repo = await repository(directory);
  const marker = path.join(directory, 'ran');
  const script = path.join(directory, 'evil.sh');
  await writeFile(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat\n`);
  await chmod(script, 0o755);
  git(repo, 'config', 'filter.evil.clean', script);
  git(repo, 'config', 'filter.evil.required', 'true');
  git(repo, 'config', 'core.fsmonitor', script);
  git(repo, 'config', 'diff.external', script);
  await writeFile(path.join(repo, '.gitattributes'), '* filter=evil diff=evil\n');
  git(repo, 'config', 'diff.evil.textconv', script);
  const facts = await readFacts(repo, { env });
  assert.equal(facts.branch, 'feature');
  await assert.rejects(readFile(marker, 'utf8'), 'nothing the repository configures ran');
});

test('icon: a good PNG and SVG; a link out of the root, an oversize file, wrong magic and a link to another type are refused', async t => {
  const { directory } = await scratch(t);
  const root = path.join(directory, 'w');
  await mkdir(path.join(root, 'public'), { recursive: true });
  assert.equal(await iconOf(root), undefined);
  // An SVG in public/ is found…
  await writeFile(path.join(root, 'public', 'favicon.svg'), SVG);
  assert.equal(await iconOf(root), `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
  // …but an earlier candidate wins.
  await writeFile(path.join(root, 'icon.png'), PNG);
  assert.equal(await iconOf(root), `data:image/png;base64,${PNG.toString('base64')}`);
  await rm(path.join(root, 'icon.png'));
  await rm(path.join(root, 'public', 'favicon.svg'));

  // A link that leaves the workspace: refused, even to a real PNG.
  const outside = path.join(directory, 'outside.png');
  await writeFile(outside, PNG);
  await symlink(outside, path.join(root, 'icon.png'));
  assert.equal(await iconOf(root), undefined);
  await rm(path.join(root, 'icon.png'));
  // A link inside the root to a PNG is fine; to another type (named .png) is not.
  await mkdir(path.join(root, 'art'));
  await writeFile(path.join(root, 'art', 'mark.png'), PNG);
  await symlink(path.join(root, 'art', 'mark.png'), path.join(root, 'logo.png'));
  assert.equal(await iconOf(root), `data:image/png;base64,${PNG.toString('base64')}`);
  await rm(path.join(root, 'logo.png'));
  await writeFile(path.join(root, 'art', 'secret.txt'), PNG);
  await symlink(path.join(root, 'art', 'secret.txt'), path.join(root, 'logo.png'));
  assert.equal(await iconOf(root), undefined);
  await rm(path.join(root, 'logo.png'));
  // Oversize.
  await writeFile(path.join(root, 'icon.png'), Buffer.concat([PNG, Buffer.alloc(FACTS.iconMaxBytes)]));
  assert.equal(await iconOf(root), undefined);
  // Wrong magic: a text file named .png, an HTML file named .svg, a PNG named .ico.
  await writeFile(path.join(root, 'icon.png'), 'hello');
  await writeFile(path.join(root, 'logo.svg'), '<html><script>alert(1)</script></html>');
  await writeFile(path.join(root, 'favicon.ico'), PNG);
  assert.equal(await iconOf(root), undefined);
  // A directory named like a candidate.
  await rm(path.join(root, 'icon.png'));
  await mkdir(path.join(root, 'icon.png'));
  assert.equal(await iconOf(root), undefined);
  assert.ok(ICON_CANDIDATES.every(name => !path.isAbsolute(name) && !name.split('/').includes('..')));
});

/** A fake alpd connection that answers registry.owner with these workspaces (and a removed project's). */
function registryDaemon(workspaces) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push([method, params]);
      assert.equal(method, 'registry.owner');
      return { registry: { revision: 1, projects: [{ id: 'p', root: '/p' }, { id: 'gone', root: '/gone', removedAt: '2026-01-01T00:00:00Z' }], workspaces: [...workspaces.map(([id, directory]) => ({ id, projectId: 'p', directory, labels: [] })), { id: 'w-removed', projectId: 'gone', directory: '/gone', labels: [] }], sessions: {}, labels: { catalog: [] } } };
    },
  };
}

test('the handler: ids resolved through the registry only (unknown and removed ones left out); params are never paths', { skip: skipGit }, async t => {
  const { directory, bin, env } = await scratch(t);
  const repo = await repository(directory);
  const log = await fakeGh(bin, directory);
  const json = path.join(directory, 'pr.json');
  await writeFile(json, JSON.stringify({ number: 9, state: 'OPEN', isDraft: false, statusCheckRollup: [] }));
  await writeFile(path.join(repo, 'logo.svg'), SVG);
  const { handler } = createWorkspaceFacts({ env: { ...env, FAKE_GH_JSON: json, FAKE_GH_LOG: log } });
  const daemon = registryDaemon([['w1', repo]]);
  const result = await handler({ method: 'host.workspace.facts', params: { workspaceIds: ['w1', 'nope', 'w-removed', repo] }, principal: 'owner', daemon });
  assert.deepEqual(Object.keys(result.workspaces), ['w1']);
  const { fetchedAt, ...facts } = result.workspaces.w1;
  assert.ok(!Number.isNaN(Date.parse(fetchedAt)));
  assert.deepEqual(facts, { branch: 'feature', additions: 4, deletions: 1, pr: { number: 9, state: 'open' }, icon: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}` });
  assert.deepEqual(daemon.calls, [['registry.owner', {}]]);
  await assert.rejects(handler({ params: { workspaceIds: [] }, daemon }), error => error.code === -32602);
  // The exported table registers the method.
  assert.equal(typeof methods['host.workspace.facts'], 'function');
});

test('the handler is bounded: cached for the TTL, refresh rate limited, one read per directory in flight, at most FACTS.concurrency at once', async t => {
  let clock = 1_000_000;
  let reads = 0, running = 0, most = 0;
  /** @type {Array<() => void>} */
  let gates = [];
  const read = async () => {
    reads++; running++; most = Math.max(most, running);
    await new Promise(resolve => gates.push(resolve));
    running--;
    return { branch: `b${reads}` };
  };
  const { handler } = createWorkspaceFacts({ env: {}, now: () => clock, read });
  const ids = Array.from({ length: 10 }, (_, i) => [`w${i}`, `/ws/${i}`]);
  const daemon = registryDaemon(ids);
  const ask = (workspaceIds, refresh) => handler({ params: { workspaceIds, ...(refresh ? { refresh } : {}) }, daemon });
  /** Opens every gate until `promise` settles. */
  const settle = async promise => {
    let done = false;
    promise.finally(() => { done = true; }).catch(() => {});
    while (!done) { const open = gates; gates = []; open.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)); }
    return promise;
  };

  // Three overlapping polls of the same ten workspaces: ten reads, never more than the limit at once.
  const [first, second, third] = await settle(Promise.all([ask(ids.map(([id]) => id)), ask(ids.map(([id]) => id)), ask(ids.map(([id]) => id), true)]));
  assert.equal(reads, 10);
  assert.ok(most <= FACTS.concurrency, `at most ${FACTS.concurrency} at once, saw ${most}`);
  assert.equal(most, FACTS.concurrency);
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);

  // Within the TTL: no read. refresh within FACTS.refreshMinMs: still none.
  clock += 5_000;
  await ask(['w0']);
  await ask(['w0'], true);
  assert.equal(reads, 10);
  // refresh after FACTS.refreshMinMs: read again.
  clock += FACTS.refreshMinMs;
  await settle(ask(['w0'], true));
  assert.equal(reads, 11);
  // After the TTL, a plain poll reads again.
  clock += FACTS.ttlMs;
  assert.equal((await settle(ask(['w1']))).workspaces.w1.branch, 'b12');
  assert.equal(reads, 12);
  // A read that throws is an answer without facts, not an error.
  const failing = createWorkspaceFacts({ env: {}, now: () => clock, read: async () => { throw new Error('boom'); } });
  const answer = await failing.handler({ params: { workspaceIds: ['w2'] }, daemon });
  assert.deepEqual(Object.keys(answer.workspaces.w2), ['fetchedAt']);
});

test('review fixes (PR #354): an empty or failed read is cached only for FACTS.refreshMinMs; an all-digit branch asks no gh; isInside is not fooled by "..name"', { skip: skipGit }, async t => {
  // An empty or failed answer is read again after FACTS.refreshMinMs, without refresh.
  let clock = 1_000_000, reads = 0;
  const { handler } = createWorkspaceFacts({ env: {}, now: () => clock, read: async () => { reads++; if (reads === 1) throw new Error('timeout'); return reads === 2 ? {} : { branch: 'b' }; } });
  const daemon = registryDaemon([['w0', '/ws/0']]);
  const ask = () => handler({ params: { workspaceIds: ['w0'] }, daemon });
  await ask();
  await ask();
  assert.equal(reads, 1, 'within FACTS.refreshMinMs the failed answer is reused');
  clock += FACTS.refreshMinMs;
  await ask();
  assert.equal(reads, 2, 'a failed answer is read again after FACTS.refreshMinMs');
  clock += FACTS.refreshMinMs;
  assert.equal((await ask()).workspaces.w0.branch, 'b', 'so is an empty one');
  clock += FACTS.refreshMinMs;
  await ask();
  assert.equal(reads, 3, 'an answer with facts is kept for the TTL');

  // A branch named like a pull request number: no gh call (gh would read it as PR #123).
  const { directory, bin, env } = await scratch(t);
  const repo = await repository(directory);
  git(repo, 'checkout', '-q', '-b', '123');
  const log = await fakeGh(bin, directory);
  const json = path.join(directory, 'pr.json');
  await writeFile(json, JSON.stringify({ number: 123, state: 'OPEN', isDraft: false, statusCheckRollup: [] }));
  const facts = await readFacts(repo, { env: { ...env, FAKE_GH_JSON: json, FAKE_GH_LOG: log } });
  assert.equal(facts.branch, '123');
  assert.equal(facts.pr, undefined);
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '');

  assert.ok(isInside('/w', '/w'));
  assert.ok(isInside('/w', '/w/..name'));
  assert.ok(isInside('/w', '/w/a/b'));
  assert.ok(!isInside('/w', '/x'));
  assert.ok(!isInside('/w', '/w2'));
  assert.ok(!isInside('/w', '/'));
});

test('onPath skips a PATH entry that is a link into the workspace', { skip: skipGit }, async t => {
  const { directory, bin } = await scratch(t);
  const workspace = path.join(directory, 'ws');
  await mkdir(path.join(workspace, 'bin'), { recursive: true });
  await writeFile(path.join(workspace, 'bin', 'gh'), '#!/bin/sh\n');
  await chmod(path.join(workspace, 'bin', 'gh'), 0o755);
  const link = path.join(directory, 'linked-bin');
  await symlink(path.join(workspace, 'bin'), link);
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(workspace);
  assert.equal(await onPath('gh', { PATH: link }, root), undefined);
  assert.equal(await onPath('gh', { PATH: path.join(workspace, 'bin') }, root), undefined);
  // Outside the workspace it is found.
  await fakeGh(bin, directory);
  assert.ok(await onPath('gh', { PATH: [link, bin].join(path.delimiter) }, root));
});
