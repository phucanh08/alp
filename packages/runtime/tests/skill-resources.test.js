import test from 'node:test';
import assert from 'node:assert/strict';
import { pathActions, resourceUses } from '@anhlp/alp-runtime';

const skills = [{ name: 'bug-loop', path: '/home/u/.alp/skills/bug-loop/SKILL.md' }, { name: 'xia', path: '/p/.alp/skills/xia/SKILL.md' }];
const uses = command => resourceUses(command, skills).map(use => `${use.action} ${use.skill}/${use.resource}`);

test('reading a reference counts, by shell, by Claude Read, by an ACP read, by path or by plugin link', () => {
  assert.deepEqual(uses('cat /home/u/.alp/skills/bug-loop/references/test-proof.md'), ['read bug-loop/references/test-proof.md']);
  assert.deepEqual(uses("sed -n 1,40p '/home/u/.alp/skills/bug-loop/references/test-proof.md'"), ['read bug-loop/references/test-proof.md']);
  assert.deepEqual(uses("bash -lc 'head -20 /home/u/.alp/skills/bug-loop/references/test-proof.md | wc -l'"), ['read bug-loop/references/test-proof.md']);
  assert.deepEqual(uses('Read {"file_path":"/tmp/alp-skills/u1/skills/bug-loop/references/test-proof.md"}'), ['read bug-loop/references/test-proof.md']);
  assert.deepEqual(uses('read: Read /p/.alp/skills/xia/references/sources.md'), ['read xia/references/sources.md']);
  // Windows: backslashes, doubled as JSON writes them.
  assert.deepEqual(resourceUses('Read {"file_path":"C:\\\\Users\\\\u\\\\.alp\\\\skills\\\\bug-loop\\\\references\\\\a.md"}', [{ name: 'bug-loop', path: 'C:\\Users\\u\\.alp\\skills\\bug-loop\\SKILL.md' }]).map(use => use.resource), ['references/a.md']);
});

test('running a script counts as run, its data arguments as read', () => {
  assert.deepEqual(uses('node /home/u/.alp/skills/bug-loop/scripts/check.mjs --root .'), ['run bug-loop/scripts/check.mjs']);
  assert.deepEqual(uses('/home/u/.alp/skills/bug-loop/scripts/check.mjs'), ['run bug-loop/scripts/check.mjs']);
  assert.deepEqual(uses('cd repo && FORCE=1 python3 /home/u/.alp/skills/bug-loop/scripts/a.py /home/u/.alp/skills/bug-loop/data/rows.csv'), ['run bug-loop/scripts/a.py', 'read bug-loop/data/rows.csv']);
});

test('writing, listing, copying or naming a file, and tool output, are not openings', () => {
  for (const command of [
    'Edit {"file_path":"/home/u/.alp/skills/bug-loop/references/test-proof.md","old_string":"a","new_string":"b"}',
    'Write {"file_path":"/home/u/.alp/skills/bug-loop/references/new.md","content":"x"}',
    'Glob {"pattern":"/home/u/.alp/skills/bug-loop/references/*.md"}',
    'ls /home/u/.alp/skills/bug-loop/references/',
    'cp /home/u/.alp/skills/bug-loop/references/test-proof.md /tmp/x.md',
    'echo /home/u/.alp/skills/bug-loop/references/test-proof.md',
    'edit: Edit /home/u/.alp/skills/bug-loop/references/test-proof.md',
    'grep -rl proof ~/.alp',
  ]) assert.deepEqual(uses(command), [], command);
  // Another skill's directory is not this agent's.
  assert.deepEqual(uses('cat /home/u/.alp/skills/unknown/references/a.md'), []);
  assert.deepEqual(pathActions('cat a b'), [{ file: 'a', action: 'read' }, { file: 'b', action: 'read' }]);
});
