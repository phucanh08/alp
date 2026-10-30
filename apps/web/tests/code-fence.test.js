// A Markdown code fence's info string as the file name the highlighter picks a parser by
// (lib/code-fence.js): Paseo's aliases, the first word only, and fence names that are
// Object.prototype members never read from the prototype.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fenceFilename } from '../src/lib/code-fence.js';

test('a fence names its file by extension, through Paseo\'s aliases', () => {
  assert.equal(fenceFilename('ts'), 'code.ts');
  assert.equal(fenceFilename('typescript {1,3}'), 'code.ts');
  assert.equal(fenceFilename('  Python  '), 'code.py');
  assert.equal(fenceFilename('.rs'), 'code.rs');
  assert.equal(fenceFilename('c++'), 'code.cpp');
  assert.equal(fenceFilename('swift'), 'code.swift');
  for (const empty of [null, undefined, '', '   ']) assert.equal(fenceFilename(empty), null, String(empty));
});

test('fence names that are Object.prototype members are plain names, not inherited values', () => {
  assert.equal(fenceFilename('constructor'), 'code.constructor');
  assert.equal(fenceFilename('__proto__'), 'code.__proto__');
  assert.equal(fenceFilename('toString'), 'code.tostring');
  assert.equal(fenceFilename('hasOwnProperty'), 'code.hasownproperty');
});
