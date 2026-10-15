// NDJSON framing for stream transports, without Buffer (docs/alp/client-sdk.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineDecoder, utf8Length } from '@anhlp/alp-client/portable';

test('utf8Length agrees with Buffer for ASCII, multi-byte, astral and unpaired surrogates', () => {
  for (const text of ['', 'abc', 'é', 'Phở cà phê', '中文', '😀 emoji', '\ud800', 'a\udc00b', '\ud83d']) {
    assert.equal(utf8Length(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
  }
});

test('frames split across chunks come out whole and in order; blank lines are skipped', () => {
  const decoder = createLineDecoder({ maxFrame: 1024 });
  assert.deepEqual(decoder.push('{"a":'), []);
  assert.deepEqual(decoder.push('1}\n\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
  assert.equal(decoder.buffered, 4);
  assert.deepEqual(decoder.push(':3}\n'), ['{"c":3}']);
  assert.equal(decoder.buffered, 0);
});

test('a frame over the limit fails, whether complete or still arriving, and the decoder stays failed', () => {
  const complete = createLineDecoder({ maxFrame: 8 });
  assert.throws(() => complete.push('123456789\n'), RangeError);
  assert.throws(() => complete.push('{}\n'), /already failed/);
  const arriving = createLineDecoder({ maxFrame: 8 });
  arriving.push('12345');
  assert.throws(() => arriving.push('6789'), RangeError);
  // The limit counts UTF-8 bytes, not UTF-16 units: four 3-byte characters are 12 bytes.
  assert.throws(() => createLineDecoder({ maxFrame: 8 }).push('中文中文\n'), RangeError);
  assert.deepEqual(createLineDecoder({ maxFrame: 8 }).push('12345678\n'), ['12345678']);
});
