import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRule } from '@anhlp/alp-core/permissions';

// The checked Bash rules (`Bash(@…)`) as parseRule reads them: which kinds take a root, and which roots
// are accepted. Pins checkedRule and cleanAbsolute through the public parser.

const refused = /a checked rule is Bash\(@git-clone-public <root>\), Bash\(@git-read <root>\) or Bash\(@git-unsafe\)/;

test('Bash(@git-unsafe) takes no root; a root or another tool refuses it', () => {
  assert.deepEqual(parseRule('Bash(@git-unsafe)'), { tool: 'Bash', specifier: '@git-unsafe' });
  assert.deepEqual(parseRule('Bash( @git-unsafe )'), { tool: 'Bash', specifier: '@git-unsafe' }, 'trimmed');
  assert.throws(() => parseRule('Bash(@git-unsafe x)'), refused);
  assert.throws(() => parseRule('Bash(@git-unsafe /tmp/repo)'), refused);
  assert.throws(() => parseRule('Read(@git-unsafe)'), refused, 'a checked rule is a Bash rule');
});

test('Bash(@git-clone-public) and Bash(@git-read) need a root: absolute and normal, or ~/<dir>', () => {
  for (const kind of ['git-clone-public', 'git-read']) {
    assert.throws(() => parseRule(`Bash(@${kind})`), refused, `${kind} without a root`);
    assert.deepEqual(parseRule(`Bash(@${kind} /tmp/repos)`), { tool: 'Bash', specifier: `@${kind} /tmp/repos` });
    assert.deepEqual(parseRule(`Bash(@${kind} ~/cache)`), { tool: 'Bash', specifier: `@${kind} ~/cache` });
    for (const root of ['/', '~/', '~', 'tmp/repos', '/tmp/repos/', '/tmp//repos', '/tmp/./repos', '/tmp/../repos', '~user/x', '~/../x']) {
      assert.throws(() => parseRule(`Bash(@${kind} ${root})`), refused, `${kind} ${root}`);
    }
    assert.throws(() => parseRule(`Bash(@${kind} /a /b)`), refused, 'one root only');
  }
});

test('an unknown checked kind is refused, not read as a plain command', () => {
  for (const rule of ['Bash(@git-push)', 'Bash(@Git-unsafe)', 'Bash(@)', 'Bash(@git_read /tmp)']) assert.throws(() => parseRule(rule), refused, rule);
});
