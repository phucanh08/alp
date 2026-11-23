import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPack, listPacks, validatePack } from '../src/packs.js';
import { ADVISORS, READ_ONLY_ROLES, commandDecision, profileFor } from '../src/permissions.js';
import { BUILTIN_AGENTS, resolveAgent } from '../src/resolver.js';
import { TEAM_ROLES, resolveTeam } from '../src/teams.js';

// The research pack: two read-only advisors (librarian, scout) and two variant teams. Phở and Cafe stay as they are.

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-research-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  return { root, library: path.join(directory, 'home') };
}

// The shipped rules name /tmp/alp-librarian (the user's choice, t-6dc5 g1), which every local user shares: the
// tests put a scratch root in its place (librarianProfile, scoped), so nothing here makes or reads the real one.
const ROOT = '/tmp/alp-librarian';
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'alp-research-root-'));
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const CACHE = `${SCRATCH}/alp-librarian`;
/** The profile with its checked rules moved from /tmp/alp-librarian to `root`. */
const scopedTo = (profile, root) => ({ ...profile, allow: profile.allow.map(rule => rule.replace(ROOT, root)) });

const ADVISORS_OF_PACK = ['librarian', 'scout'];
// The librarian's profile, as pack.json carries it and the install writes it (t-6dc5 G5-B).
const LIBRARIAN = {
  base: 'read-only',
  allow: ['Bash(@git-clone-public /tmp/alp-librarian)', 'Bash(@git-read /tmp/alp-librarian)', 'WebFetch(domain:github.com)', 'WebFetch(domain:raw.githubusercontent.com)', 'WebFetch(domain:gitlab.com)'],
  ask: ['Bash(git clone:*)', 'Bash(git fetch:*)', 'Bash(git -C:*)', 'Bash(gh repo clone:*)'],
  deny: ['Bash(@git-unsafe)', 'Bash(git push:*)', 'Bash(rm:*)'],
};

test('the research pack is valid and lists two agents, two variant teams and read-only permissions', async () => {
  const pack = (await listPacks()).find(candidate => candidate.id === 'research');
  assert.ok(pack, 'research ships');
  assert.equal(pack.label, 'Research');
  assert.deepEqual(pack.agents, ['librarian', 'scout']);
  assert.deepEqual(pack.teams, ['pho-research', 'cafe-research']);
  assert.deepEqual(pack.permissions, { librarian: LIBRARIAN, scout: 'read-only' });
  assert.deepEqual(pack.skills, []);
  // No new built-in agent, no dashboard id, no new team role.
  for (const name of ADVISORS_OF_PACK) assert.ok(!BUILTIN_AGENTS.includes(name) && !ADVISORS.includes(name));
  assert.ok(!pack.agents.includes('finder'));
  assert.deepEqual(TEAM_ROLES, ['lead', 'peer', 'advisor', 'reviewer']);
});

test('installing the pack adds librarian and scout, read-only, and both variant teams', async t => {
  const { root, library } = await scratch(t);
  const result = await installPack('research', { scope: 'library', library });
  assert.deepEqual(result.installed.map(entry => `${entry.kind}/${entry.name}`), ['agents/librarian', 'agents/scout', 'teams/pho-research', 'teams/cafe-research']);
  assert.deepEqual(result.permissions, { set: ['librarian: profile librarian (read-only, 5 allow, 4 ask, 3 deny)', 'scout: read-only'], kept: [], conflicts: [] });
  const written = JSON.parse(await readFile(path.join(library, 'settings.json'), 'utf8')).permissions;
  assert.deepEqual(written.agents, { librarian: 'librarian', scout: 'read-only' });
  assert.deepEqual(written.profiles, { librarian: LIBRARIAN });

  const librarian = await resolveAgent(root, { agent: 'librarian', library });
  assert.equal(librarian.source, 'library');
  assert.equal(librarian.mode, 'read-only');
  assert.deepEqual(librarian.runtime, { model: 'claude:claude-sonnet-5', reasoning: 'medium' });
  assert.match(librarian.instructions.agent, /^# Librarian/);
  assert.match(librarian.instructions.agent, /repo@sha:path:line/);
  assert.deepEqual(librarian.skills, []);
  const scout = await resolveAgent(root, { agent: 'scout', library });
  assert.equal(scout.mode, 'read-only');
  assert.deepEqual(scout.runtime, { model: 'claude:haiku', reasoning: 'low' });
  assert.match(scout.instructions.agent, /^# Scout/);
  assert.match(scout.instructions.agent, /Không tìm thấy \/ chưa chắc/);
  assert.deepEqual(scout.skills, []);
  for (const name of ADVISORS_OF_PACK) assert.equal((await profileFor(root, library, name)).base, 'read-only');
});

test('Phở + Research: main reaches scout and librarian; both are advisors that delegate to nobody', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  const team = await resolveTeam(root, 'pho-research', { library });
  const pho = await resolveTeam(root, 'pho', { library });
  assert.equal(team.source, 'library');
  assert.deepEqual(team.delegation, { main: [...pho.delegation.main, 'librarian', 'scout'] });
  // Otherwise the same as Phở.
  assert.equal(team.maxPeers, pho.maxPeers);
  assert.deepEqual(team.supervisor, pho.supervisor);
  assert.deepEqual(Object.fromEntries(Object.entries(team.members).filter(([name]) => !ADVISORS_OF_PACK.includes(name))), pho.members);
  assert.ok(team.houseRules.startsWith(pho.houseRules.replace('Ở Phở (pho)', 'Ở Phở + Research (pho-research)')));
  assert.match(team.houseRules, /Dùng scout khi workspace lớn/);
  assert.match(team.houseRules, /Dùng librarian khi hành vi của một thư viện bên ngoài/);
  for (const name of ADVISORS_OF_PACK) {
    assert.equal(team.members[name].role, 'advisor');
    assert.ok(READ_ONLY_ROLES.includes(team.members[name].role), `${name} serves read-only`);
    assert.ok(!Object.hasOwn(team.delegation, name), `${name} delegates to nobody`);
  }
  // Only peer members count against maxPeers (runtime: roleOf(...) === 'peer').
  assert.deepEqual(Object.entries(team.members).filter(([, member]) => member.role === 'peer').map(([name]) => name), ['peer']);
});

test('Cafe + Research: lead reaches both, main reaches librarian only', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  const team = await resolveTeam(root, 'cafe-research', { library });
  const cafe = await resolveTeam(root, 'cafe', { library });
  assert.deepEqual(team.delegation, {
    main: [...cafe.delegation.main, 'librarian'],
    lead: [...cafe.delegation.lead, 'librarian', 'scout'],
  });
  assert.ok(!team.delegation.main.includes('scout'));
  assert.equal(team.maxPeers, cafe.maxPeers);
  assert.deepEqual(team.supervisor, cafe.supervisor);
  assert.deepEqual(Object.fromEntries(Object.entries(team.members).filter(([name]) => !ADVISORS_OF_PACK.includes(name))), cafe.members);
  assert.ok(team.houseRules.startsWith(cafe.houseRules.replace('Ở Cafe (cafe)', 'Ở Cafe + Research (cafe-research)')));
  for (const name of ADVISORS_OF_PACK) {
    assert.equal(team.members[name].role, 'advisor');
    assert.ok(!Object.hasOwn(team.delegation, name));
  }
});

test('default Phở and Cafe gain no member and no delegation edge, installed or not', async t => {
  const { root, library } = await scratch(t);
  const before = { pho: await resolveTeam(root, 'pho', { library }), cafe: await resolveTeam(root, 'cafe', { library }) };
  await installPack('research', { scope: 'library', library });
  for (const id of ['pho', 'cafe']) {
    const team = await resolveTeam(root, id, { library });
    assert.equal(team.source, 'builtin');
    assert.deepEqual(team.delegation, before[id].delegation);
    assert.deepEqual(team.members, before[id].members);
    for (const name of ADVISORS_OF_PACK) {
      assert.ok(!Object.hasOwn(team.members, name));
      assert.ok(!Object.values(team.delegation).flat().includes(name));
    }
  }
  assert.deepEqual(before.pho.delegation, { main: ['peer', 'oracle', 'reviewer'] });
  assert.deepEqual(before.cafe.delegation, { main: ['lead', 'oracle', 'reviewer'], lead: ['peer', 'oracle', 'reviewer'] });
});

test('serving as a team advisor, librarian and scout stay read-only even when settings give them full access', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ permissions: { agents: { librarian: 'full-access', scout: 'workspace-write' } } }));
  for (const [name, from] of [['librarian', 'full-access'], ['scout', 'workspace-write']]) {
    const profile = await profileFor(root, library, name, { readOnly: true });
    assert.equal(profile.base, 'read-only');
    assert.equal(profile.cappedFrom, from);
  }
});

// t-6dc5 G5-B: the librarian may clone and fetch public repositories into /tmp/alp-librarian, and read them
// there, through checked rules (permissions.js coversChecked); everything else stays read-only or asks.
async function librarianProfile(t) {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  return { root, library, profile: scopedTo(await profileFor(root, library, 'librarian', { readOnly: true }), CACHE) };
}

// Each was allowed by a prefix rule the old matcher could express (Bash(git -C <root>*), Bash(git clone:*),
// Bash(git fetch:*)); with the hardened profile none of them is allowed.
const BYPASSES = [
  [`git -C ${CACHE}/../x push`, 'deny'],
  [`git -C ${CACHE}/../repo log`, 'ask'],
  [`git -C ${CACHE}X log`, 'ask'],
  ['git fetch', 'ask'],
  ['git fetch origin', 'ask'],
  ['git clone https://github.com/a/b', 'ask'],
  ['git clone https://github.com/a/b ./src', 'ask'],
  [`git clone https://github.com/a/b ${CACHE}/../../workspace`, 'ask'],
  [`git clone https://github.com/a/b ${CACHE}//a-b`, 'ask'],
  [`git clone https://github.com/a/b ${CACHE}/./a-b`, 'ask'],
  [`git clone https://github.com/a/b ${CACHE}/a-b/`, 'ask'],
  ['git clone https://github.com/a/b ~/alp-librarian/a-b', 'ask'],
  [`git clone https://github.com/a/b ${CACHE}`, 'ask'],
  [`git clone https://evil.example/a/b ${CACHE}/a-b`, 'ask'],
  [`git clone https://github.com.evil.example/a/b ${CACHE}/a-b`, 'ask'],
  [`git clone https://user@github.com/a/b ${CACHE}/a-b`, 'ask'],
  [`git clone git@github.com:a/b ${CACHE}/a-b`, 'ask'],
  [`git clone ssh://git@github.com/a/b ${CACHE}/a-b`, 'ask'],
  [`git clone file:///etc ${CACHE}/a-b`, 'ask'],
  [`git clone /Users/me/project ${CACHE}/a-b`, 'ask'],
  [`git clone --recurse-submodules https://github.com/a/b ${CACHE}/a-b`, 'ask'],
  [`git clone --template=/tmp/t https://github.com/a/b ${CACHE}/a-b`, 'deny'],
  [`git clone -u /tmp/evil https://github.com/a/b ${CACHE}/a-b`, 'deny'],
  [`git clone --upload-pack=/tmp/evil https://github.com/a/b ${CACHE}/a-b`, 'deny'],
  [`git clone -c core.fsmonitor=/tmp/evil https://github.com/a/b ${CACHE}/a-b`, 'deny'],
  [`git clone --config core.hooksPath=/tmp/h https://github.com/a/b ${CACHE}/a-b`, 'deny'],
  [`git -C ${CACHE}/a-b -c core.sshCommand=x fetch`, 'deny'],
  [`git -c core.fsmonitor=x -C ${CACHE}/a-b log`, 'deny'],
  [`git -C ${CACHE}/a-b fetch --upload-pack=/tmp/evil`, 'deny'],
  [`git -C ${CACHE}/a-b fetch -u`, 'deny'],
  [`git -C ${CACHE}/a-b fetch https://evil.example/x`, 'ask'],
  [`git -C ${CACHE}/a-b fetch /Users/me/project`, 'ask'],
  [`git -C ${CACHE}/a-b push`, 'deny'],
  [`git -C ${CACHE}/a-b push origin main`, 'deny'],
  [`git --git-dir=${CACHE}/a-b/.git push`, 'deny'],
  [`/usr/bin/git -C ${CACHE}/a-b push`, 'deny'],
  ['env GIT_DIR=x git push', 'deny'],
  [`sh -c 'git -C ${CACHE}/a-b push'`, 'deny'],
  [`git -C ${CACHE}/a-b config core.hooksPath /tmp/h`, 'deny'],
  [`git -C ${CACHE}/a-b remote set-url origin https://evil.example/x`, 'deny'],
  [`git -C ${CACHE}/a-b hook run pre-commit`, 'deny'],
  [`git -C ${CACHE}/a-b log --output=/Users/me/project/x`, 'ask'],
  [`git -C ${CACHE}/a-b diff --no-index /etc/passwd /dev/null`, 'ask'],
  [`git -C ${CACHE}/a-b grep -O x`, 'ask'],
  [`git -C ${CACHE}/a-b branch -D main`, 'ask'],
  [`git -C ${CACHE}/a-b checkout main`, 'ask'],
  [`git -C ${CACHE}/a-b log && git push`, 'deny'],
  [`git -C ${CACHE}/a-b log; git -C ${CACHE}/a-b push`, 'deny'],
  [`git -C ${CACHE}/a-b log | tee /tmp/x`, undefined],
  [`git -C ${CACHE}/a-b log > /Users/me/project/x`, 'ask'],
  [`git -C ${CACHE}/a-b log $(touch /tmp/x)`, 'deny'],
  [`gh repo clone a/b ${CACHE}/a-b`, 'ask'],
];
const ALLOWED = [
  `git clone --depth 50 https://github.com/a/b ${CACHE}/a-b`,
  `git clone https://gitlab.com/group/project.git ${CACHE}/project`,
  `git clone --filter=blob:none --single-branch -b v1.2 https://github.com/a/b.git ${CACHE}/a-b`,
  `git -C ${CACHE}/a-b fetch --depth 50`,
  `git -C ${CACHE}/a-b fetch origin main --tags`,
  `git -C ${CACHE}/a-b log -S x`,
  `git -C ${CACHE}/a-b log --oneline v1.0..v1.2 -- src/index.js`,
  `git -C ${CACHE}/a-b show HEAD:src/index.js`,
  `git -C ${CACHE}/a-b grep -n "createServer" -- lib`,
  `git -C ${CACHE}/a-b blame -L 10,20 src/index.js`,
  `git -C ${CACHE}/a-b rev-parse HEAD`,
  `git -C ${CACHE}/a-b branch -a`,
  `/bin/zsh -lc 'git -C ${CACHE}/a-b log -1 && git -C ${CACHE}/a-b rev-parse HEAD'`,
];

test('the librarian clones and reads public repositories only below /tmp/alp-librarian; every bypass asks or is denied', async t => {
  const { profile } = await librarianProfile(t);
  assert.equal(profile.base, 'read-only');
  // The root as the first clone leaves it (a clone elsewhere no longer creates it): reads are judged below it.
  mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  for (const [command, expected] of BYPASSES) assert.equal(commandDecision(profile, command), expected, command);
  for (const command of ALLOWED) assert.equal(commandDecision(profile, command), 'allow', command);
  // Workspace commands keep the read-only base: no rule covers them.
  for (const command of ['git log', 'git status', 'git diff', 'touch src/x.js', 'npm test']) assert.equal(commandDecision(profile, command), undefined, command);
});

test('a link below the librarian root that leads elsewhere is not below it', { skip: process.platform === 'win32' }, async t => {
  const { profile } = await librarianProfile(t);
  // A scratch root stands in for /tmp/alp-librarian: the rules are the shipped ones with another root, mode 0700.
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-librarian-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'clones');
  await mkdir(path.join(root, 'real'), { recursive: true });
  await chmod(root, 0o700);
  await mkdir(path.join(directory, 'workspace'));
  await symlink(path.join(directory, 'workspace'), path.join(root, 'escape'));
  const scoped = { ...profile, allow: profile.allow.map(rule => rule.replace(CACHE, root)) };
  assert.equal(commandDecision(scoped, `git -C ${root}/real log`), 'allow');
  assert.equal(commandDecision(scoped, `git clone https://github.com/a/b ${root}/new`), 'allow');
  assert.equal(commandDecision(scoped, `git -C ${root}/escape log`), 'ask');
  assert.equal(commandDecision(scoped, `git clone https://github.com/a/b ${root}/escape/b`), 'ask');
});

// Round 2 (security review of PR #378, reproduced with git 2.54): git accepts unambiguous abbreviations of long options
// and clusters of short ones, so a denylist let `grep --open-f=...` and `grep -iO<cmd>` run a pager command, and
// options with a path value read files outside the clone. @git-read now takes only the options it lists, exactly.
const OPTION_BYPASSES = [
  "grep --open-f='touch /tmp/pwn #' hi", "grep --open='sh -c id' hi", 'grep --open-files-in-pager=touch hi', 'grep -iOtouch hi',
  'grep -nOtouch hi', 'grep -O hi', 'grep -Otouch hi', 'grep -inO hi', 'grep --file=/etc/passwd', 'grep -f /etc/passwd', 'grep -if/etc/passwd',
  'grep -e /etc/passwd', 'grep --no-index hi /etc', 'grep --no-ind hi', 'grep --recurse-submodules hi', 'grep --ext hi',
  'blame --contents=/etc/passwd a.js', 'blame --contents /etc/passwd a.js', 'blame --cont=/etc/passwd a.js', 'blame --ignore-revs-file=/etc/passwd a.js',
  'blame --ignore-revs-f=/x a.js', 'blame -S /etc/passwd a.js', 'ls-files --exclude-from=/etc/passwd', 'ls-files -X /etc/passwd', 'ls-files --exclude-f=/x',
  'log --output=/tmp/x', 'log --out=/tmp/x', 'log --outp x', 'log --ext-diff', 'log --ext', 'log --textconv', 'log --textc', 'log --show-signature',
  'log --name-on', 'log --one', 'log -O/etc/passwd -p', 'log -pO/etc/passwd', 'diff --no-index /etc/passwd /dev/null', 'diff --no-i /etc/passwd x',
  'diff --orderfile=/etc/passwd', 'diff -O/etc/passwd', 'diff --relative=../x', 'show --output=x HEAD', 'show HEAD -- /etc/passwd',
  'show --format=x --since=/etc', 'cat-file --textconv HEAD:a', 'cat-file --filters HEAD:a', 'cat-file --path=a HEAD', 'rev-parse --resolve-git-dir /etc',
  'rev-parse --git-path x', 'log --end-of-options HEAD', 'log -- ../x', 'grep x -- ../../etc', 'log -L 1,2:../x',
];
const OPTION_READS = [
  'log --oneline -n 20', 'log -5 --format=%H%x09%an%x09%s --since=2.weeks', 'log -p -S createServer -- src', 'log --stat --follow -- src/a.js',
  'log -n5 --graph --decorate --all', 'log -L 10,20:src/a.js', 'log --author=someone --grep=fix -i', 'log -G foo -U5 --word-diff',
  'grep -n -i -e foo -C 3 -- lib', 'grep -niw foo', 'grep -A3 -B 2 foo', 'grep -c foo', 'grep -l -E "a|b" -- src', 'grep --max-depth=2 --heading --break foo',
  'blame -L 10,20 -w src/a.js', 'blame --porcelain -M -C50 src/a.js', 'show --stat HEAD', 'show HEAD~2:src/a.js', 'show --name-only --format=%H v1',
  'diff --name-only v1..v2', 'diff -M50% --stat v1 v2 -- src', 'diff --cached', 'ls-files -z', "ls-files --cached --format='%(path)'", 'cat-file -p HEAD',
  'cat-file -t HEAD', 'rev-parse --abbrev-ref HEAD', 'rev-parse --short=8 HEAD', 'rev-parse --show-toplevel',
];

test('@git-read allows only the options it lists, exactly: no abbreviation, cluster or path option leaves the clone', { skip: process.platform === 'win32' }, async t => {
  const { profile } = await librarianProfile(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-librarian-options-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'clones');
  await mkdir(path.join(root, 'a-b'), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const scoped = { ...profile, allow: profile.allow.map(rule => rule.replace(CACHE, root)) };
  for (const args of OPTION_BYPASSES) assert.equal(commandDecision(scoped, `git -C ${root}/a-b ${args}`), 'ask', args);
  for (const args of OPTION_READS) assert.equal(commandDecision(scoped, `git -C ${root}/a-b ${args}`), 'allow', args);
  // A path inside the clone may be named absolutely.
  assert.equal(commandDecision(scoped, `git -C ${root}/a-b log -- ${root}/a-b/src`), 'allow');
  assert.equal(commandDecision(scoped, `git -C ${root}/a-b grep --max-depth=${root}/x foo`), 'ask');
});

test('the librarian root (/tmp/alp-librarian): created 0700 by the first clone; refused when a link, a file, not 0700 (0755/0777) or under a parent others may write', { skip: process.platform === 'win32' }, async t => {
  const { profile } = await librarianProfile(t);
  const clone = target => commandDecision(profile, `git clone https://github.com/a/b ${target}`);
  const read = target => commandDecision(profile, `git -C ${target} log --oneline`);
  // Missing root: a read is not allowed, the first clone creates the root 0700 before git runs, so no one can put
  // a directory or link of theirs there between ALP's check and git's write.
  rmSync(CACHE, { recursive: true, force: true });
  assert.equal(read(`${CACHE}/a-b`), 'ask');
  assert.equal(clone(`${CACHE}/a-b`), 'allow');
  const made = statSync(CACHE);
  assert.ok(made.isDirectory());
  assert.equal(made.mode & 0o777, 0o700);
  assert.equal(made.uid, process.getuid());
  assert.equal(read(`${CACHE}/a-b`), 'allow');

  // Scratch roots stand in for a root another user squatted or swapped (only root may chown, so a squatted root
  // here is one this user does not hold as 0700: open to others, a link, or a file).
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-librarian-root-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scoped = root => ({ ...profile, allow: profile.allow.map(rule => rule.replace(CACHE, root)) });
  const decide = (root, command) => commandDecision(scoped(root), command);
  const squatted = path.join(directory, 'squatted');
  mkdirSync(squatted, { mode: 0o777 });
  await chmod(squatted, 0o777);
  const shared = path.join(directory, 'shared');
  mkdirSync(shared);
  await chmod(shared, 0o755);
  const mine = path.join(directory, 'mine');
  mkdirSync(mine, { mode: 0o700 });
  const swapped = path.join(directory, 'swapped');
  await symlink(mine, swapped);
  const file = path.join(directory, 'file');
  await writeFile(file, '');
  const parent = path.join(directory, 'open');
  mkdirSync(path.join(parent, 'root'), { recursive: true, mode: 0o700 });
  await chmod(parent, 0o777);
  await chmod(path.join(parent, 'root'), 0o700);
  for (const root of [squatted, shared, swapped, file, path.join(parent, 'root')]) {
    assert.equal(decide(root, `git clone https://github.com/a/b ${root}/a-b`), 'ask', root);
    assert.equal(decide(root, `git -C ${root}/a-b log`), 'ask', root);
  }
  assert.equal(decide(mine, `git clone https://github.com/a/b ${mine}/a-b`), 'allow');
  // A clone for anywhere else never makes the root: the shipped rule, with a target outside /tmp/alp-librarian.
  const absent = path.join(directory, 'absent');
  assert.equal(decide(absent, `git clone https://github.com/a/b ${directory}/elsewhere/a-b`), 'ask');
  assert.equal(existsSync(absent), false, 'a clone outside the root does not create it');
  // A missing root whose parent is open to others is not created.
  assert.equal(decide(path.join(parent, 'new'), `git clone https://github.com/a/b ${parent}/new/a-b`), 'ask');
  // A rule names an absolute root or ~/<dir>, nothing else.
  const files = { 'packs/x/agents/a/AGENT.md': '# A', 'packs/x/agents/a/agent.json': JSON.stringify({ mode: 'read-only' }) };
  const pack = rule => validatePack('x', { label: 'X', description: 'x', agents: ['a'], permissions: { a: { base: 'read-only', allow: [rule] } } }, files);
  assert.ok(pack('Bash(@git-read /tmp/alp-librarian)'));
  assert.ok(pack('Bash(@git-read ~/.alp-librarian-cache)'));
  for (const rule of ['Bash(@git-read ~)', 'Bash(@git-read ~/)', 'Bash(@git-read ~/../x)', 'Bash(@git-read ~user/x)', 'Bash(@git-read x)']) assert.throws(() => pack(rule), /a checked rule is/, rule);
});

test('the deny path reads a git command the way the shell will: escaping backslashes and quotes are taken out', async t => {
  const { profile } = await librarianProfile(t);
  for (const command of ['g\\it push', '\\git push', 'git pu\\sh $X', `git -C ${CACHE}/a-b pu\\sh origin`, "g'i't push $X", 'git -c\\ core.x=y log $X'])
    assert.equal(commandDecision(profile, command), 'deny', command);
});

test('the librarian stays read-only under a full-access parent and settings that try to widen it', async t => {
  const { root, library } = await librarianProfile(t);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ permissions: { profiles: { librarian: { base: 'full-access' } }, agents: { librarian: 'librarian' } } }));
  const profile = scopedTo(await profileFor(root, library, 'librarian', { readOnly: true }), CACHE);
  assert.equal(profile.base, 'read-only');
  assert.equal(profile.cappedFrom, 'full-access');
  // Its rules still hold under the cap: push is denied, the checked clone allowed.
  assert.equal(commandDecision(profile, `git -C ${CACHE}/a-b push`), 'deny');
  assert.equal(commandDecision(profile, `git clone https://github.com/a/b ${CACHE}/a-b`), 'allow');
});

test('a pack may give a read-only agent rules, never a wider base', async () => {
  const files = { 'packs/x/agents/a/AGENT.md': '# A', 'packs/x/agents/a/agent.json': JSON.stringify({ mode: 'read-only' }) };
  const manifest = permissions => ({ label: 'X', description: 'x', agents: ['a'], permissions: { a: permissions } });
  assert.ok(validatePack('x', manifest({ base: 'read-only', allow: ['Bash(@git-read /tmp/x)'], deny: ['Bash(@git-unsafe)'] }), files));
  assert.throws(() => validatePack('x', manifest('full-access'), files), /a is read-only \(agent\.json\), so its base must be read-only, not full-access/);
  assert.throws(() => validatePack('x', manifest({ base: 'workspace-write', allow: [] }), files), /base must be read-only, not workspace-write/);
  assert.throws(() => validatePack('x', manifest({ base: 'read-only', beyondMode: 'ask' }), files), /unsupported field 'beyondMode'/);
  assert.throws(() => validatePack('x', manifest({ base: 'read-only', allow: ['Bash(@git-read /tmp/../x)'] }), files), /a checked rule is/);
  assert.throws(() => validatePack('x', manifest({ allow: [] }), files), /permissions\.a\.base must be one of/);
});

test('installing keeps a librarian profile the user already has and reports it', async t => {
  const { library } = await scratch(t);
  await mkdir(library, { recursive: true });
  const mine = { base: 'read-only', allow: ['Bash(npm test:*)'] };
  await writeFile(path.join(library, 'settings.json'), JSON.stringify({ permissions: { profiles: { librarian: mine } } }));
  const result = await installPack('research', { scope: 'library', library });
  assert.match(result.permissions.conflicts.join('\n'), /already defines permissions\.profiles\.librarian, which differs from the pack's; left as it is/);
  const written = JSON.parse(await readFile(path.join(library, 'settings.json'), 'utf8')).permissions;
  assert.deepEqual(written.profiles.librarian, mine);
  assert.ok(!Object.hasOwn(written.agents, 'librarian'));
  assert.equal(written.agents.scout, 'read-only');
  // A second install finds what the first wrote and changes nothing.
  const { library: fresh } = await scratch(t);
  await installPack('research', { scope: 'library', library: fresh });
  const before = await readFile(path.join(fresh, 'settings.json'), 'utf8');
  await rm(path.join(fresh, 'agents'), { recursive: true });
  const again = await installPack('research', { scope: 'library', library: fresh });
  assert.deepEqual(again.permissions, { set: [], kept: ['librarian: profile librarian', "scout: 'read-only'"], conflicts: [] });
  assert.equal(await readFile(path.join(fresh, 'settings.json'), 'utf8'), before);
});
