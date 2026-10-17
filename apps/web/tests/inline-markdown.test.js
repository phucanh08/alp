// RichText's inline Markdown (apps/web/src/app/RichText.tsx): link targets with one level of
// balanced parentheses (Wikipedia's `Foo_(bar)`), and every span bounded, so a long adversarial
// line (a 1 MiB Markdown file in a file tab's preview) is read in linear time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INLINE, splitLink } from '../src/lib/inline-markdown.js';

const KINDS = ['code', 'strong', 'strike', 'link', 'url', 'em'];
/** The tokens RichText's Inline makes of `text`, as it walks it: [kind, token] or ['text', text]. */
function tokens(text) {
  const out = [];
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) { out.push(['text', rest]); break; }
    if (match.index) out.push(['text', rest.slice(0, match.index)]);
    out.push([KINDS[match.slice(1).findIndex(Boolean)], match[0]]);
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

test('a link target may hold one level of balanced parentheses (Wikipedia)', () => {
  const href = 'https://en.wikipedia.org/wiki/Foo_(bar)';
  assert.deepEqual(tokens(`See [Foo](${href}) now.`), [['text', 'See '], ['link', `[Foo](${href})`], ['text', ' now.']]);
  assert.deepEqual(splitLink(`[Foo](${href})`), { text: 'Foo', href });
  assert.deepEqual(splitLink('[a](x_(y)_z)'), { text: 'a', href: 'x_(y)_z' });
  assert.deepEqual(splitLink('[a]((y))'), { text: 'a', href: '(y)' });
  assert.deepEqual(splitLink('[a](b)'), { text: 'a', href: 'b' }, 'a plain target as before');
  assert.deepEqual(tokens('[a](b) (c)'), [['link', '[a](b)'], ['text', ' (c)']]);
  assert.deepEqual(tokens('([a](src/a.ts))'), [['text', '('], ['link', '[a](src/a.ts)'], ['text', ')']], 'a link in parentheses keeps its own');
});

test('targets that are not one balanced level are not links', () => {
  for (const text of ['[a]()', '[a](b(c(d)))', '[a](b(c)', '[a](b c)', '[a](b(c d))', '[a](b(c)d(e))']) {
    assert.ok(!tokens(text).some(([kind, token]) => kind === 'link' && token.startsWith('[a]')), `${text}: ${JSON.stringify(tokens(text))}`);
    assert.equal(splitLink(text), undefined, text);
  }
});

test('a target is bounded: 2048 characters on either side of its parentheses at most', () => {
  const long = 'x'.repeat(2048);
  assert.equal(splitLink(`[a](${long}(${long})${long})`)?.href.length, 3 * 2048 + 2);
  assert.equal(splitLink(`[a](${long}x)`), undefined);
  assert.ok(!tokens(`[a](${long}x)`).some(([kind]) => kind === 'link'));
});

test('long adversarial lines are read in linear time', () => {
  const size = 1024 * 1024;
  const fill = unit => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const lines = {
    'open brackets': fill('['),
    'link openings': fill('[a]('),
    'nested openings': fill('[a](('),
    'paren openings': fill('[a](x('),
    'unclosed inner': fill(`[a](${'x'.repeat(100)}(${'y'.repeat(100)}`),
    'balanced but unclosed': fill(`[a](x(y)${'z'.repeat(50)}`),
    'long target runs': fill(`[a](${'x'.repeat(3000)}`),
    'parens only': fill('(()'),
    'stars': fill('*a'),
    'underscores': fill(' _a'),
    'backticks': fill('`a'),
    'urls': fill('http://a('),
    'links': fill('[Foo](https://e/Foo_(bar)) '),
  };
  for (const [name, line] of Object.entries(lines)) {
    const started = performance.now();
    const count = tokens(line).length;
    const elapsed = performance.now() - started;
    assert.ok(count > 0);
    assert.ok(elapsed < 3000, `${name}: ${elapsed.toFixed(0)} ms`);
  }
});
