import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSession } from '../../dist/runtime/index.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'project');
  return { home, root, file: path.join(root, '.alp/settings.json') };
}
const cli = ({ home, root }, ...args) => spawnSync(process.execPath, ['packages/cli/src/cli.js', 'setup', root, ...args], { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8' });
const read = async file => JSON.parse(await readFile(file, 'utf8'));
/** setup's record of what it wrote, in project state beside the settings. */
const record = f => read(path.join(f.root, '.alp/state/setup-profiles.json'));

test('setup mix writes main on one model, the others with both providers and efforts, and peers on any model', async t => {
  const f = await fixture(t);
  const result = cli(f, '--runtime', 'mix');
  assert.equal(result.status, 0, result.stderr);
  const settings = await read(f.file);
  assert.equal(settings.workflow.mode, 'pho', 'a project without settings is initialized first');
  assert.deepEqual(Object.keys(settings.team.pho), ['main', 'peer', 'reviewer', 'supervisor', 'oracle']);
  assert.deepEqual(Object.keys(settings.team.cafe), ['main', 'lead', 'peer', 'reviewer', 'supervisor', 'oracle']);
  for (const id of ['pho', 'cafe']) {
    assert.deepEqual(settings.team[id].main.profiles, ['claude:claude-opus-5-5:high']);
    for (const name of id === 'cafe' ? ['lead', 'reviewer'] : ['reviewer']) assert.deepEqual(settings.team[id][name].profiles, ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high']);
    assert.deepEqual(settings.team[id].peer.profiles, ['claude:*', 'codex:*']);
    assert.deepEqual(settings.team[id].supervisor.profiles, ['claude:claude-sonnet-5:medium', 'codex:gpt-6-luna:medium']);
    assert.deepEqual(settings.team[id].oracle.profiles, ['claude:claude-fable-5-1:high', 'codex:gpt-6-astra:low'], 'GPT-6 Astra takes low only');
    for (const config of Object.values(settings.team[id])) assert.equal(config.autocompact, 'auto');
  }
  const main = await resolveSession({ cwd: f.root }, { library: f.home });
  assert.equal(`${main.runtimeKind}:${main.model}`, 'claude:claude-opus-5-5');
  assert.equal(main.thinking, 'high');
  assert.deepEqual(main.oracleModels, ['claude:claude-fable-5-1', 'codex:gpt-6-astra']);
  const astra = await resolveSession({ cwd: f.root, agent: 'oracle', model: 'codex:gpt-6-astra' }, { library: f.home });
  assert.equal(astra.thinking, 'low', 'GPT-6 Astra runs at low');
  assert.deepEqual(main.modelProfiles.peer.map(profile => `${profile.provider}:${profile.model}`), ['claude:*', 'codex:*']);
});

test('setup mix takes chosen models, native or prefixed, and can prefer Codex', async t => {
  const f = await fixture(t);
  const result = cli(f, '--runtime', 'mix', '--prefer', 'codex', '--codex-model', 'codex:gpt-6-sol', '--claude-model', 'claude-sonnet-5', '--codex-oracle', 'gpt-6-sol');
  assert.equal(result.status, 0, result.stderr);
  const { team: profile } = await read(f.file);
  assert.deepEqual(profile.cafe.main.profiles, ['codex:gpt-6-sol:high']);
  assert.deepEqual(profile.cafe.lead.profiles, ['codex:gpt-6-sol:high', 'claude:claude-sonnet-5:high']);
  assert.deepEqual(profile.cafe.oracle.profiles, ['codex:gpt-6-sol:high', 'claude:claude-fable-5-1:high']);
  assert.deepEqual(profile.cafe.peer.profiles, ['codex:*', 'claude:*']);
  const main = await resolveSession({ cwd: f.root }, { library: f.home });
  assert.equal(`${main.runtimeKind}:${main.model}`, 'codex:gpt-6-sol');
});

for (const runtime of ['codex', 'claude']) test(`setup ${runtime} only keeps one provider and the rest of the file`, async t => {
  const f = await fixture(t);
  assert.equal(cli(f, '--runtime', 'mix').status, 0);
  const settings = await read(f.file);
  settings.workflow.mode = 'cafe';
  settings.team.cafe.peer.autocompact = 200000;
  settings.team.cafe.main.commands = ['model'];
  settings.team.mine = { main: { profiles: ['codex:gpt-5.5'] } };
  await writeFile(f.file, JSON.stringify(settings));
  const result = cli(f, '--runtime', runtime);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /replace the pho and cafe profiles ALP or an earlier alp setup wrote/);
  assert.deepEqual(await read(`${f.file}.bak`), settings, 'the replaced file is backed up');
  const after = await read(f.file);
  assert.equal(after.workflow.mode, 'cafe');
  assert.deepEqual(after.team.mine, settings.team.mine);
  assert.equal(after.team.cafe.peer.autocompact, 200000);
  assert.deepEqual(after.team.cafe.main.commands, ['model'], 'alp setup keeps the "/" commands (t-efa3)');
  for (const id of ['pho', 'cafe']) {
    for (const config of Object.values(after.team[id])) assert.deepEqual(config.profiles.map(profile => profile.split(':')[0]), [runtime]);
    assert.deepEqual(after.team[id].peer.profiles, [`${runtime}:*`]);
  }
});

test('invalid input writes nothing', async t => {
  const f = await fixture(t);
  for (const args of [['--runtime', 'codex', '--claude-model', 'claude-opus-5-5'], ['--runtime', 'mix', '--claude-model', 'codex:gpt-6-sol'], ['--runtime', 'claude', '--prefer', 'codex'], []]) {
    assert.equal(cli(f, ...args).status, 1, args.join(' '));
  }
  await assert.rejects(access(f.file));
});

test('a settings file that is not JSON is named and left alone', async t => {
  const f = await fixture(t);
  assert.equal(cli(f, '--runtime', 'mix').status, 0);
  const broken = (await readFile(f.file, 'utf8')).replace('"auto"', '"auto"\x10');
  await writeFile(f.file, broken);
  const result = cli(f, '--runtime', 'codex');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settings\.json is not valid JSON/);
  assert.equal(await readFile(f.file, 'utf8'), broken);
});

/** A team of the project's own (or an override of a built-in id) in .alp/teams/<id>/team.json. */
async function projectTeam(root, id, members, extra = {}) {
  await mkdir(path.join(root, '.alp', 'teams', id), { recursive: true });
  await writeFile(path.join(root, '.alp', 'teams', id, 'team.json'), JSON.stringify({ label: id, main: 'main', members, delegation: { main: Object.keys(members).filter(name => name !== 'main') }, ...extra }));
}
const lists = team => Object.fromEntries(Object.entries(team).map(([name, config]) => [name, config.profiles]));

test('setup leaves a custom team\'s profiles alone and names the settings keys to edit', async t => {
  const f = await fixture(t);
  // Like this repository's own agy team: a team of the project's whose team.json chooses Antigravity models.
  await projectTeam(f.root, 'agy', { main: { model: 'antigravity:gemini-3.8-flash-high' }, peer: { role: 'peer', model: 'antigravity:gemini-3.8-flash-high' }, reviewer: { role: 'reviewer', model: 'claude:sonnet', thinking: 'high' } });
  const result = cli(f, '--runtime', 'mix');
  assert.equal(result.status, 0, result.stderr);
  const after = await read(f.file);
  assert.deepEqual(lists(after.team.agy), { main: ['antigravity:gemini-3.8-flash-high'], peer: ['antigravity:gemini-3.8-flash-high'], reviewer: ['claude:sonnet:high'] }, 'setup writes no Claude or Codex model into a team that chose its own');
  assert.equal((await record(f)).teams.agy, undefined);
  // Not silent: the team id, the exact key and the file are named.
  assert.match(result.stdout, /Team agy \(project\) is not Phở or Cafe, so alp setup leaves its profiles as they are/);
  assert.ok(result.stdout.includes(`edit team.agy.<agent>.profiles in ${f.file} (agents: main, peer, reviewer)`), result.stdout);
  // Phở and Cafe still get both providers.
  assert.deepEqual(after.team.cafe.peer.profiles, ['claude:*', 'codex:*']);
});

test('setup keeps profiles written by hand and rewrites only what ALP or setup wrote', async t => {
  const f = await fixture(t);
  assert.equal(cli(f, '--runtime', 'claude').status, 0);
  const before = await read(f.file);
  before.team.pho.peer.profiles = ['codex:gpt-6-sol:low'];
  before.team.cafe.reviewer.profiles = ['claude:claude-sonnet-5:high', 'claude:sonnet'];
  await writeFile(f.file, JSON.stringify(before, null, 2));
  const result = cli(f, '--runtime', 'mix');
  assert.equal(result.status, 0, result.stderr);
  const after = await read(f.file);
  assert.deepEqual(after.team.pho.peer.profiles, ['codex:gpt-6-sol:low'], 'the user\'s own list stays');
  assert.deepEqual(after.team.cafe.reviewer.profiles, ['claude:claude-sonnet-5:high', 'claude:sonnet']);
  assert.match(result.stdout, /Kept team\.pho\.peer\.profiles \(codex:gpt-6-sol:low\): written by hand/);
  assert.match(result.stdout, /Kept team\.cafe\.reviewer\.profiles \(claude:claude-sonnet-5:high, claude:sonnet\): written by hand/);
  // What the claude-only setup wrote is setup's, so mix replaces it with both providers.
  assert.deepEqual(after.team.cafe.peer.profiles, ['claude:*', 'codex:*']);
  assert.deepEqual(after.team.pho.reviewer.profiles, ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high']);
  assert.equal((await record(f)).teams.pho.peer, undefined, 'a kept entry is not recorded as setup\'s');
  assert.deepEqual(await read(`${f.file}.bak`), before);
});

test('settings.json gains no key an older ALP would refuse; setup\'s record is project state', async t => {
  const f = await fixture(t);
  assert.equal(cli(f, '--runtime', 'mix').status, 0);
  // validateSettings refuses an unknown top-level key, so bookkeeping there would break an older alpd.
  assert.deepEqual(Object.keys(await read(f.file)).sort(), ['defaultAgent', 'team', 'templateDefaults', 'workflow']);
  const { version, teams } = await record(f);
  assert.equal(version, 1);
  assert.deepEqual(Object.keys(teams.cafe).sort(), ['lead', 'main', 'oracle', 'peer', 'reviewer', 'supervisor']);
  for (const hash of Object.values(teams.cafe)) assert.match(hash, /^[a-f0-9]{64}$/);
});

test('a project without setup\'s record (set up before it, or cloned without it) is still rewritten by the next setup', async t => {
  const f = await fixture(t);
  assert.equal(cli(f, '--runtime', 'mix').status, 0);
  await rm(path.join(f.root, '.alp/state'), { recursive: true });
  const result = cli(f, '--runtime', 'claude');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Kept /);
  const after = await read(f.file);
  for (const id of ['pho', 'cafe']) for (const config of Object.values(after.team[id])) assert.deepEqual(config.profiles.map(profile => profile.split(':')[0]), ['claude']);
});

test('a Phở or Cafe override that names a member\'s model keeps that member\'s profile', async t => {
  const f = await fixture(t);
  // As this repository's .alp/teams/cafe/team.json does for reviewer.
  await projectTeam(f.root, 'cafe', { main: { model: 'claude:claude-opus-5-5', thinking: 'high' }, lead: { role: 'lead' }, peer: { role: 'peer' }, reviewer: { role: 'reviewer', model: 'claude:sonnet', thinking: 'high' } }, { delegation: { main: ['lead', 'reviewer'], lead: ['peer', 'reviewer'] } });
  const result = cli(f, '--runtime', 'mix');
  assert.equal(result.status, 0, result.stderr);
  const after = await read(f.file);
  assert.deepEqual(after.team.cafe.reviewer.profiles, ['claude:sonnet:high']);
  assert.match(result.stdout, /Kept team\.cafe\.reviewer\.profiles \(claude:sonnet:high\): the cafe team's team\.json names its model \(claude:sonnet\)/);
  assert.deepEqual(after.team.cafe.lead.profiles, ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high'], 'a member the override does not pin gets both providers');
  assert.deepEqual(after.team.pho.reviewer.profiles, ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high']);
});

test('setup\'s record ignores itself in Git, and a bad one never stops setup', async t => {
  const f = await fixture(t);
  assert.equal(cli(f, '--runtime', 'mix').status, 0);
  const state = path.join(f.root, '.alp/state');
  assert.equal(await readFile(path.join(state, '.gitignore'), 'utf8'), '*\n');
  assert.equal(spawnSync('git', ['init', '-q', f.root]).status, 0);
  const ignored = spawnSync('git', ['-C', f.root, 'check-ignore', '.alp/state/setup-profiles.json', '.alp/state/.gitignore'], { encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.equal(spawnSync('git', ['-C', f.root, 'check-ignore', '-q', '.alp/settings.json']).status, 1, 'settings stay committable');
  const recordPath = path.join(state, 'setup-profiles.json');
  // Truncated, not JSON, of a newer version, or a directory: setup still runs, by its known defaults.
  for (const [what, damage] of [
    ['truncated', () => writeFile(recordPath, '{"version": 1, "tea')],
    ['the wrong shape', () => writeFile(recordPath, JSON.stringify({ version: 1, teams: { cafe: { lead: 42 } } }))],
    ['a newer version', () => writeFile(recordPath, JSON.stringify({ version: 99, other: true }))],
    ['a directory', async () => { await rm(recordPath, { force: true }); await mkdir(recordPath); }],
  ]) {
    await damage();
    for (const runtime of ['claude', 'mix']) {
      const result = cli(f, '--runtime', runtime);
      assert.equal(result.status, 0, `${what}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /Kept /, what);
      assert.deepEqual((await read(f.file)).team.cafe.peer.profiles, runtime === 'mix' ? ['claude:*', 'codex:*'] : ['claude:*'], what);
    }
    if (what === 'a newer version') assert.deepEqual(await read(recordPath), { version: 99, other: true }, 'a newer ALP\'s record is left alone');
    if (what === 'a directory') assert.match(cli(f, '--runtime', 'mix').stdout, /Could not save \S+setup-profiles\.json/);
    else if (what !== 'a newer version') assert.equal((await read(recordPath)).version, 1, `${what}: rewritten`);
  }
});
