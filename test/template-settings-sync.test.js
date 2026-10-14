import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '../packages/core/src/init.js';
import { getEntry, saveEntry } from '../packages/core/src/library-edit.js';
import { resolveWorkflow } from '../packages/core/src/workflow.js';

const cli = fileURLToPath(new URL('../packages/cli/src/cli.js', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-template-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { root: path.join(directory, 'project'), library: path.join(directory, 'home') };
}
async function codexTemplate(library) {
  const { content } = await getEntry('teams', 'pho', { library });
  for (const [name, member] of Object.entries(content.team.members)) if (name !== 'oracle') { member.model = 'codex:gpt-6.1-sol'; member.thinking = 'low'; }
  content.team.supervisor.model = 'codex:gpt-6.1-sol'; content.team.supervisor.thinking = 'low';
  content.team.oracleModels = ['codex:gpt-6.1-sol']; content.team.oracleThinking = { 'codex:gpt-6.1-sol': 'low' };
  await saveEntry('teams', 'pho', content, { library, scope: 'library' });
}
for (const command of ['init', 'upgrade', 'update']) test(`${command} refreshes a project's generated model profiles from the saved template`, async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  await codexTemplate(library);
  const result = spawnSync(process.execPath, [cli, command], { cwd: root, env: { ...process.env, ALP_HOME: library }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8'));
  assert.deepEqual(settings.team.pho.main.profiles, ['codex:gpt-6.1-sol:low']);
  assert.deepEqual(settings.team.pho.oracle.profiles, ['codex:gpt-6.1-sol:low']);
  assert.equal((await resolveWorkflow(root, undefined, undefined, { library })).team.members.main.model, 'codex:gpt-6.1-sol');
});

test('a new project uses the template saved in Settings', async t => {
  const { root, library } = await fixture(t);
  await codexTemplate(library);
  await initProject(root, { library });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8')).team.pho.main.profiles, ['codex:gpt-6.1-sol:low']);
});

test('OpenCode-only template initializes a valid project using the provider default', async t => {
  const { root, library } = await fixture(t);
  const { content } = await getEntry('teams', 'pho', { library });
  for (const [name, member] of Object.entries(content.team.members)) if (name !== 'oracle') { member.model = 'acp:opencode'; delete member.thinking; }
  content.team.supervisor.model = 'acp:opencode'; delete content.team.supervisor.thinking;
  content.team.oracleModels = ['acp:opencode']; content.team.oracleThinking = {};
  await saveEntry('teams', 'pho', content, { library, scope: 'library' });
  await initProject(root, { library });
  const workflow = await resolveWorkflow(root, undefined, undefined, { library });
  assert.equal(workflow.team.members.main.model, 'acp:opencode');
  assert.deepEqual(workflow.team.oracleModels, ['acp:opencode']);
});

test('template refresh preserves hand-edited project models, effort, autocompact and unrelated settings', async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.team.pho.peer = { profiles: ['claude:claude-sonnet-5:medium'], autocompact: 250000 };
  settings.team.pho.main.autocompact = 300000;
  settings.workflow.supervisor = false;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(settings));
  await codexTemplate(library);
  await initProject(root, { library });
  const next = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(next.team.pho.peer, settings.team.pho.peer);
  assert.deepEqual(next.team.pho.main, { profiles: ['codex:gpt-6.1-sol:low'], autocompact: 300000 });
  assert.equal(next.workflow.supervisor, false);
  const before = await readFile(file, 'utf8');
  await initProject(root, { library });
  assert.equal(await readFile(file, 'utf8'), before, 'repeated init is idempotent');
});

test('a project initialized before tracking was introduced refreshes shipped defaults', async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  delete settings.templateDefaults;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(settings));
  await codexTemplate(library);
  await initProject(root, { library });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).team.pho.main.profiles, ['codex:gpt-6.1-sol:low']);
});

test('mode and models persist on library and project templates, including custom team IDs', async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  await codexTemplate(library);
  const { content } = await getEntry('teams', 'pho', { library });
  content.team.modelSetup = { mode: 'default', preset: 'codex' };
  await saveEntry('teams', 'work', content, { library, scope: 'library' });
  const reloaded = await getEntry('teams', 'work', { library });
  assert.deepEqual(reloaded.content.team.modelSetup, { mode: 'default', preset: 'codex' });
  await initProject(root, { library });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8')).team.work.main.profiles, ['codex:gpt-6.1-sol:low']);
  content.team.modelSetup = { mode: 'custom' };
  content.team.members.main.model = 'claude:claude-sonnet-5'; content.team.members.main.thinking = 'medium';
  await saveEntry('teams', 'work', content, { root, library, scope: 'project' });
  await initProject(root, { library });
  assert.deepEqual((await getEntry('teams', 'work', { root, library })).content.team.modelSetup, { mode: 'custom' });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8')).team.work.main.profiles, ['claude:claude-sonnet-5:medium']);
});

test('legacy inherited profile objects migrate cleanly while retaining compaction', async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.team.pho.main = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', autocompact: 300000 };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(settings));
  await codexTemplate(library);
  await initProject(root, { library });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).team.pho.main, { profiles: ['codex:gpt-6.1-sol:low'], autocompact: 300000 });
});

test('opening a new session refreshes its team without loading malformed unrelated templates', async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  await codexTemplate(library);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(library, 'teams/broken'), { recursive: true });
  await writeFile(path.join(library, 'teams/broken/team.json'), '{');
  const { resolveSession } = await import('../dist/runtime/index.js');
  const session = await resolveSession({ cwd: root }, { library });
  assert.equal(session.runtimeKind, 'codex');
  assert.equal(session.model, 'gpt-6.1-sol');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8')).team.pho.main.profiles, ['codex:gpt-6.1-sol:low']);
});

test('a legacy project first opened in Pho still refreshes Cafe when its template changes', async t => {
  const { root, library } = await fixture(t);
  await initProject(root, { library });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  delete settings.templateDefaults;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(settings));
  const { resolveSession } = await import('../dist/runtime/index.js');
  await resolveSession({ cwd: root, workflow: 'pho' }, { library });
  const { content } = await getEntry('teams', 'cafe', { library });
  for (const [name, member] of Object.entries(content.team.members)) if (name !== 'oracle') { member.model = 'codex:gpt-6.1-sol'; member.thinking = 'low'; }
  await saveEntry('teams', 'cafe', content, { library, scope: 'library' });
  const cafe = await resolveSession({ cwd: root, workflow: 'cafe' }, { library });
  assert.equal(cafe.runtimeKind, 'codex');
  assert.equal(cafe.model, 'gpt-6.1-sol');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).team.cafe.main.profiles, ['codex:gpt-6.1-sol:low']);
});
