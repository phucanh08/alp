import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkScenarios, disclosure } from '../../scripts/skill-eval.mjs';

test('the trigger scenarios agree with the shipped role mapping', async () => {
  assert.deepEqual(await checkScenarios(), []);
  const { scenarios } = JSON.parse(await readFile(new URL('../evals/skills/triggers.json', import.meta.url), 'utf8'));
  for (const kind of ['positive', 'negative', 'ambiguous', 'role', 'multi']) assert.ok(scenarios.some(s => s.kind === kind), kind);
});

test('progressive disclosure: each role starts with its own skill index only, never a body or a resource', async () => {
  const rows = await disclosure();
  const byRole = Object.fromEntries(rows.map(row => [row.role, row]));
  const roles = JSON.parse(await readFile(new URL('../../templates/role-skills.json', import.meta.url), 'utf8'));
  for (const [role, skills] of Object.entries(roles)) {
    assert.equal(byRole[role].skills, skills.length, role);
    assert.equal(byRole[role].bodiesInInstructions, 0, `${role}: a skill body reached the instructions`);
    // What a session could open on demand outweighs what it starts with.
    if (skills.length) assert.ok(byRole[role].bodyBytesNotLoaded + byRole[role].resourceBytesNotLoaded > byRole[role].indexChars * 4, role);
  }
  assert.equal(byRole.oracle.indexChars, 0);
  // A budget for the index: its header, then at most about 460 characters a skill (name, path, clipped description).
  for (const row of rows) assert.ok(row.indexChars <= 400 + row.skills * 460, `${row.role}: index of ${row.indexChars} characters for ${row.skills} skills`);
});
