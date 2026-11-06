// t-814a: the readers in test/support/template-text.js are what eight test files now trust instead
// of a copied sentence, so they must fail loudly rather than return something an assertion passes
// against for free. A reader that quietly returned '' would make every `assert.match(x, literal(…))`
// trivially true and every `doesNotMatch` trivially false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { literal, templateBodySentence, templateDescription, templateLineWith, templateText, templateTitle } from '../support/template-text.js';

test('the template readers return what templates/ says at a structural anchor', () => {
  assert.match(templateText('agents/peer/AGENT.md'), /^# /);
  // A title, without its '# ', and not empty.
  const title = templateTitle('agents/peer/AGENT.md');
  assert.ok(title.length > 10, title);
  assert.ok(!title.startsWith('#'), title);
  assert.ok(templateText('agents/peer/AGENT.md').includes(`# ${title}`));
  // A SKILL.md description, unquoted, exactly as the frontmatter declares it.
  const description = templateDescription('skills/xia/SKILL.md');
  assert.ok(description.length > 40, description);
  assert.ok(!description.startsWith('"') && !description.endsWith('"'), description);
  assert.ok(templateText('skills/xia/SKILL.md').includes(description));
  // One line, by something that appears in it exactly once, with list and quote markers stripped.
  const line = templateLineWith('agents/reviewer/AGENT.md', '`pass_with_findings`');
  assert.ok(line.startsWith('`pass_with_findings`'), line);
  assert.ok(templateText('agents/reviewer/AGENT.md').includes(line));
  // A body sentence that is NOT in the description: the thing an index-only agent must not receive.
  const body = templateBodySentence('skills/feature-architecture/SKILL.md');
  assert.ok(body.length >= 40, body);
  assert.ok(templateText('skills/feature-architecture/SKILL.md').includes(body));
  assert.ok(!templateDescription('skills/feature-architecture/SKILL.md').includes(body), body);
});

test('every template reader throws on a missing or ambiguous anchor, never returns nothing', () => {
  for (const [read, pattern] of [
    [() => templateText('agents/nobody/AGENT.md'), /no template at agents\/nobody\/AGENT\.md \(ENOENT\)/],
    // A template with no '# ' heading at all: teams/pho/HOUSE_RULES.md is prose from its first line.
    [() => templateTitle('teams/pho/HOUSE_RULES.md'), /no '# ' title/],
    [() => templateDescription('agents/peer/AGENT.md'), /has no frontmatter/],
    [() => templateLineWith('agents/peer/AGENT.md', 'this string is in no template'), /no line of .* contains/],
    // 'the' is in many lines: an ambiguous anchor must be refused, not silently resolved to the first.
    [() => templateLineWith('agents/peer/AGENT.md', 'a'), /lines of .* contain .*; anchor on something that appears once/],
  ]) assert.throws(read, pattern);
});

test('literal() matches its text and nothing it does not', () => {
  assert.match('a (b) c.d', literal('(b) c.d'));
  assert.doesNotMatch('a b c_d', literal('(b) c.d'));
  // Regex metacharacters are matched as themselves, which is the whole point.
  assert.match('cost is $5 [net]', literal('$5 [net]'));
  assert.doesNotMatch('cost is X5 Xnet', literal('$5 [net]'));
});
