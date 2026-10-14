import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSession } from '../dist/runtime/index.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'project');
  return { home, root, file: path.join(root, '.alp/settings.json') };
}
const cli = ({ home, root }, ...args) => spawnSync(process.execPath, ['packages/cli/src/cli.js', 'setup', root, ...args], { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8' });
const read = async file => JSON.parse(await readFile(file, 'utf8'));

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
  settings.team.mine = { main: { profiles: ['codex:gpt-5.5'] } };
  await writeFile(f.file, JSON.stringify(settings));
  const result = cli(f, '--runtime', runtime);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /replace the pho and cafe profiles/);
  assert.deepEqual(await read(`${f.file}.bak`), settings, 'the replaced file is backed up');
  const after = await read(f.file);
  assert.equal(after.workflow.mode, 'cafe');
  assert.deepEqual(after.team.mine, settings.team.mine);
  assert.equal(after.team.cafe.peer.autocompact, 200000);
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
