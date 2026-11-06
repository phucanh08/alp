import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudePermissions, skillPlugin, SKILL_PLUGIN } from '../../dist/runtime/index.js';
import { renderLog } from '../../packages/client/src/render.js';
import { tree, until } from '../support/fake-agent.js';

test('Claude gets the agent\'s skills to load as its own; Codex finds them in its instructions', async t => {
  const claude = await tree(t, { prefix: 'alp-skill-', open: { model: 'claude:claude-opus-5-5' } });
  const config = claude.main.config;
  assert.deepEqual(config.skills.map(skill => skill.name), ['architecture-docs', 'bug-loop', 'compact', 'curate', 'feature-architecture', 'goal-griller', 'prompt-leverage', 'release-readiness', 'safe-refactor', 'security-review', 'sequence-execution-plan', 'skill-authoring', 'smart-commits', 'test-strategy', 'xia']);
  assert.match(config.developerInstructions, /- curate \([^)]+[\\/]skills[\\/]curate[\\/]SKILL\.md\): Rà soát toàn bộ bài học/);
  assert.ok(config.skills.every(skill => skill.path.endsWith(path.join('/skills', skill.name, 'SKILL.md'))));
  assert.match(config.developerInstructions, /Your skills are also Claude Code skills named alp:<name>: run one with the Skill tool/);
  assert.match(config.developerInstructions, /- xia \([^)]+[\\/]skills[\\/]xia[\\/]SKILL\.md\): Nghiên cứu một implementation chưa quen/);

  const codex = await tree(t, { prefix: 'alp-skill-', open: { model: 'codex:gpt-5.6-sol' } });
  assert.equal(codex.main.config.skills, undefined);
  assert.doesNotMatch(codex.main.config.developerInstructions, /Claude Code skills/);
  assert.match(codex.main.config.developerInstructions, /- smart-commits \([^)]+\): Gói các thay đổi đã sở hữu/);
});

test('an agent using a skill is logged once per skill: by the Skill tool, or by reading its SKILL.md', async t => {
  const { main, agents, runLog } = await tree(t, { prefix: 'alp-skill-', open: { model: 'codex:gpt-5.6-sol' } });
  const skills = main.config.developerInstructions.match(/- xia \(([^)]+)\)/);
  const started = item => main.notification('item/started', { threadId: main.threadId, item });
  started({ type: 'commandExecution', id: 'c1', command: `cat ALP.md ${skills[1]}`, cwd: '/tmp', status: 'inProgress' });
  started({ type: 'commandExecution', id: 'c2', command: `sed -n 1,80p ${skills[1]}`, cwd: '/tmp', status: 'inProgress' });
  // Claude's Skill tool, as its transport reports it.
  started({ type: 'commandExecution', id: 'c3', command: `Skill {"skill":"${SKILL_PLUGIN}:smart-commits"}`, cwd: '/tmp', status: 'inProgress' });
  // A skill of another role is not the agent's: nothing to log.
  started({ type: 'commandExecution', id: 'c4', command: 'cat ~/.alp/skills/unknown-skill/SKILL.md', cwd: '/tmp', status: 'inProgress' });
  await until(async () => (await runLog()).filter(entry => entry.event === 'skill').length === 2, 'two skill entries');
  await new Promise(resolve => setTimeout(resolve, 30));
  const used = (await runLog()).filter(entry => entry.event === 'skill');
  assert.deepEqual(used.map(entry => [entry.agent, entry.skill, entry.via]), [['main', 'xia', 'read'], ['main', 'smart-commits', 'skill']]);
  assert.deepEqual(renderLog('root', used.map(entry => ({ ...entry, ts: '2026-01-01T10:00:00.000Z' }))), ['10:00:00  ✦ main uses skill xia', '10:00:00  ✦ main uses skill smart-commits (Skill tool)']);
  assert.equal(agents.length, 1);
});

test('a skill\'s references are logged when read and its scripts when run, once each, never preloaded; edits and output do not count', async t => {
  const { main, runLog } = await tree(t, { prefix: 'alp-skill-', open: { model: 'codex:gpt-5.6-sol' } });
  const instructions = main.config.developerInstructions;
  const bugLoop = path.dirname(instructions.match(/- bug-loop \(([^)]+)\)/)[1]);
  // Level 0 only: no body or reference text is in the instructions.
  const body = await readFile(path.join(bugLoop, 'SKILL.md'), 'utf8');
  const reference = await readFile(path.join(bugLoop, 'references', 'test-proof.md'), 'utf8');
  assert.ok(!instructions.includes(body.split('\n---\n')[1].trim().split('\n')[0]));
  assert.ok(!instructions.includes(reference.trim().split('\n')[0]));
  assert.deepEqual((await runLog()).filter(entry => entry.event === 'skill-resource'), []);
  const started = item => main.notification('item/started', { threadId: main.threadId, item });
  // Output that names a file is not an opening of it.
  main.notification('item/completed', { threadId: main.threadId, item: { type: 'commandExecution', id: 'r0', command: 'grep -rl proof ~/.alp', cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: `${bugLoop}/references/test-proof.md\n` } });
  started({ type: 'commandExecution', id: 'r1', command: `cat ${bugLoop}/references/test-proof.md`, cwd: '/tmp', status: 'inProgress' });
  started({ type: 'commandExecution', id: 'r2', command: `sed -n 1,9p ${bugLoop}/references/test-proof.md`, cwd: '/tmp', status: 'inProgress' });
  // Claude reads through its plugin link: <plugin>/skills/<name>/...
  started({ type: 'commandExecution', id: 'r3', command: 'node /tmp/alp-skills/x/skills/bug-loop/scripts/check.mjs', cwd: '/tmp', status: 'inProgress' });
  // Another role's skill directory is not this agent's, and editing a reference is not reading it.
  started({ type: 'commandExecution', id: 'r4', command: 'cat ~/.alp/skills/unknown-skill/references/a.md', cwd: '/tmp', status: 'inProgress' });
  started({ type: 'commandExecution', id: 'r5', command: `Edit ${JSON.stringify({ file_path: `${bugLoop}/references/other.md`, old_string: 'a', new_string: 'b' })}`, cwd: '/tmp', status: 'inProgress' });
  await until(async () => (await runLog()).filter(entry => entry.event === 'skill-resource').length === 2, 'two resource entries');
  await new Promise(resolve => setTimeout(resolve, 30));
  const opened = (await runLog()).filter(entry => entry.event === 'skill-resource');
  assert.deepEqual(opened.map(entry => [entry.skill, entry.resource, entry.action]), [['bug-loop', 'references/test-proof.md', 'read'], ['bug-loop', 'scripts/check.mjs', 'run']]);
  assert.deepEqual(renderLog('root', opened.map(entry => ({ ...entry, ts: '2026-01-01T10:00:00.000Z' }))), ['10:00:00  ✦ main reads bug-loop/references/test-proof.md', '10:00:00  ✦ main runs bug-loop/scripts/check.mjs']);
});

test('the skill plugin links each skill\'s own directory under the plugin name alp', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-skill-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = path.join(directory, 'plugin');
  skillPlugin(plugin, [{ name: 'xia', path: '/library/skills/xia/SKILL.md' }, { name: 'bug-loop', path: '/project/.alp/skills/bug-loop/SKILL.md' }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'alp');
  assert.equal(await readlink(path.join(plugin, 'skills', 'xia')), path.resolve('/library/skills/xia'));
  assert.equal(await readlink(path.join(plugin, 'skills', 'bug-loop')), path.resolve('/project/.alp/skills/bug-loop'));
  // Made again on a restart, from scratch.
  skillPlugin(plugin, [{ name: 'xia', path: '/library/skills/xia/SKILL.md' }]);
  await assert.rejects(lstat(path.join(plugin, 'skills', 'bug-loop')));
});

test('a read-only Claude session may run its skills', async () => {
  const fixed = claudePermissions('read-only');
  assert.ok(fixed.tools.includes('Skill'));
  const live = claudePermissions('read-only', () => 'read-only');
  assert.equal((await live.canUseTool('Skill', { skill: 'alp:xia' })).behavior, 'allow');
  assert.equal((await live.canUseTool('Write', { file_path: '/tmp/x', content: '' })).behavior, 'deny');
});

test('a supervised agent reading a SKILL.md goes on with its turn, and alp_skill saving one is still told apart (#69)', async t => {
  const { main, root, runLog } = await tree(t, { prefix: 'alp-skill-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ supervisor: true }) });
  const command = `cat ${root}/.alp/agents/main/skills/prompt-leverage/SKILL.md | head -60`;
  // A skill use was logged under the event alp_skill's saves use; the supervisor's journal read it as a save and threw.
  main.notification('item/started', { threadId: main.threadId, item: { type: 'commandExecution', id: 'c1', command, cwd: root, status: 'inProgress', aggregatedOutput: '' } });
  main.notification('item/completed', { threadId: main.threadId, item: { type: 'commandExecution', id: 'c1', command, cwd: root, status: 'completed', exitCode: 0, aggregatedOutput: '---\nname: prompt-leverage\n---\n' } });
  await until(async () => (await runLog()).some(entry => entry.event === 'skill'), 'the skill use');
  assert.deepEqual((await runLog()).filter(entry => entry.event === 'skill').map(entry => [entry.skill, entry.via]), [['prompt-leverage', 'read']]);
  assert.equal((await runLog()).filter(entry => entry.event === 'runtime.slip').length, 0);
  assert.deepEqual(renderLog('root', [{ ts: '2026-01-01T10:00:00.000Z', event: 'skill', agent: 'main', name: 'xia', roles: ['main', 'lead'] }]), ['10:00:00  ✦ main saved skill xia for main, lead']);
});
