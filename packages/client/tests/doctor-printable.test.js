// The path escaping in alp doctor's "remove by hand" comment lines is injective (t-6147): two
// different paths never print the same, and the printed text decodes back to the path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { printable } from '../src/doctor.js';

const decode = text => text.replace(/\\\\|\\u\{([0-9a-f]+)\}/g, (match, hex) => hex === undefined ? '\\' : String.fromCodePoint(parseInt(hex, 16)));

const samples = [
  '/tmp/alp-plain', '/tmp/alp-a\nb', '/tmp/alp-a\\u{a}b', '/tmp/alp-a\\\nb', '/tmp/alp-a\\\\u{a}b',
  '/tmp/alp-bidi\u202etxt', '/tmp/alp-bidi\\u{202e}txt', 'C:\\Users\\me\\alp-x', 'C:\\\\Users', '/tmp/alp-\u00a0nbsp', '/tmp/alp- space',
  '/tmp/alp-\u2028line', '/tmp/alp-tab\t', '\\', '\\\\', '\\u', '\\u{', '/tmp/alp-x\'; touch pwned; \'',
];

test('printable is one line, round-trips and keeps distinct paths distinct', () => {
  const printed = new Map();
  for (const sample of samples) {
    const out = printable(sample);
    assert.doesNotMatch(out, /[\p{C}\p{Zl}\p{Zp}]/u, JSON.stringify(out));
    assert.equal(decode(out), sample, JSON.stringify(sample));
    assert.ok(!printed.has(out), `${JSON.stringify(sample)} and ${JSON.stringify(printed.get(out))} both print ${out}`);
    printed.set(out, sample);
  }
  assert.equal(printable('/tmp/alp-a\nb'), '/tmp/alp-a\\u{a}b');
  assert.equal(printable('/tmp/alp-a\\u{a}b'), '/tmp/alp-a\\\\u{a}b');
  assert.equal(printable('/tmp/alp- space'), '/tmp/alp- space');
});
