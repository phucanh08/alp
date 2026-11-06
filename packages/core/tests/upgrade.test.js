import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { upgradeProject, shippedRoleHashes } from '../src/upgrade.js';
import { shippedTemplateRoot } from '../src/template-path.js';
import { resolveAgent } from '../src/resolver.js';

async function fixture(t, main = '# Main agent\n\nHelp with tasks in this project.\n') {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.alp/agents/main'), { recursive: true });
  await writeFile(path.join(root, '.alp/agents/main/AGENT.md'), main);
  await writeFile(path.join(root, 'ALP.md'), '# Project instructions\n\nAdd project-wide instructions here.\n');
  await writeFile(path.join(root, '.alp/settings.json'), '{"defaultAgent":"main","runtime":{"model":"my-model"}}');
  return root;
}
test('upgrade backs up original scaffold, enables routing, and preserves runtime settings', async t => {
  const root = await fixture(t);
  const result = await upgradeProject(root);
  assert.deepEqual(result.updated, ['ALP.md', '.alp/settings.json']);
  // main's copy was as shipped: it is put away, and the project uses the built-in main.
  assert.deepEqual(result.removed, ['.alp/agents/main']);
  assert.equal(await readFile(path.join(result.backup, '.alp/agents/main/AGENT.md'), 'utf8'), '# Main agent\n\nHelp with tasks in this project.\n');
  const main = await resolveAgent(root);
  assert.equal(main.source, 'builtin');
  assert.match(main.instructions.agent, /người giám sát chủ động/);
  assert.equal(await readFile(path.join(result.backup, '.alp/settings.json'), 'utf8'), '{"defaultAgent":"main","runtime":{"model":"my-model"}}');
  const settings = JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8'));
  assert.equal(settings.runtime.model, 'my-model');
  assert.deepEqual(settings.workflow, { mode: 'pho', maxPeers: 2 });
  assert.deepEqual((await upgradeProject(root)).updated, []);
});
test('upgrade preserves customized instructions and routing', async t => {
  const root = await fixture(t, 'My custom main');
  await writeFile(path.join(root, '.alp/settings.json'), '{"defaultAgent":"custom","delegation":{}}');
  const result = await upgradeProject(root);
  assert.deepEqual(result.customInstructions, ['.alp/agents/main/AGENT.md']);
  assert.equal(await readFile(path.join(root, '.alp/agents/main/AGENT.md'), 'utf8'), 'My custom main');
  const settings = JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8'));
  assert.equal(settings.defaultAgent, 'custom');
  assert.deepEqual(settings.delegation, {});
  assert.ok(settings.team.cafe.main);
  assert.ok(result.backup);
});
// t-1293: a role definition ALP once shipped but never listed in teamV1 is stranded as
// customInstructions for ever, so the project never receives any later version of it.
test('upgrade recognizes a supervisor AGENT.md from an earlier release and replaces it (t-1293)', async t => {
  const root = await fixture(t);
  const historical = await readFile(fileURLToPath(new URL('fixtures/supervisor-AGENT-61181b5.md', import.meta.url)), 'utf8');
  // 61181b5 shipped this before `.alp/agents/supervisor/AGENT.md` had any hash at all.
  assert.equal(createHash('sha256').update(historical).digest('hex'), 'a2be7e682b030d2ff122ba4e836b1c89858493a05937fa11ad1fa808e0df9c8d');
  await mkdir(path.join(root, '.alp/agents/supervisor/skills/mine'), { recursive: true });
  await writeFile(path.join(root, '.alp/agents/supervisor/skills/mine/SKILL.md'), '---\nname: mine\ndescription: keeps the directory an override\n---\n');
  await writeFile(path.join(root, '.alp/agents/supervisor/AGENT.md'), historical);
  const result = await upgradeProject(root);
  assert.ok(result.updated.includes('.alp/agents/supervisor/AGENT.md'), `updated: ${result.updated.join(', ')}`);
  assert.deepEqual(result.customInstructions, []);
  const now = await readFile(path.join(root, '.alp/agents/supervisor/AGENT.md'), 'utf8');
  assert.notEqual(now, historical);
  assert.equal(now, await readFile(new URL('agents/supervisor/AGENT.md', shippedTemplateRoot()), 'utf8'));
  // The copy it replaced is in the backup, not lost.
  assert.equal(await readFile(path.join(result.backup, '.alp/agents/supervisor/AGENT.md'), 'utf8'), historical);
});

// Keeps the list ahead of the templates: whoever changes a role definition must append the hash of
// the content they are replacing, or an existing project never receives their change (t-1293).
test('every shipped role definition is listed in teamV1', async () => {
  const missing = [];
  for (const name of Object.keys(shippedRoleHashes)) {
    const template = name === 'ALP.md' ? 'ALP.md' : name.slice('.alp/'.length);
    const text = (await readFile(new URL(template, shippedTemplateRoot()), 'utf8')).replaceAll('\r\n', '\n');
    const hash = createHash('sha256').update(text).digest('hex');
    if (!shippedRoleHashes[name].includes(hash)) missing.push(`${name} ${hash}`);
  }
  assert.deepEqual(missing, [], `append these to teamV1 in packages/core/src/upgrade.js:\n${missing.join('\n')}`);
});

test('malformed settings are rejected before migrating instructions', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.alp/settings.json'), '{');
  await assert.rejects(upgradeProject(root));
  assert.equal(await readFile(path.join(root, '.alp/agents/main/AGENT.md'), 'utf8'), '# Main agent\n\nHelp with tasks in this project.\n');
});
