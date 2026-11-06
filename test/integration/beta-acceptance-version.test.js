// t-ffe4.1: the beta acceptance harness checks that --packs is the release this checkout is
// (scripts/beta-acceptance-lib.mjs install(): `release is X, expected VERSION`, and C2's alpd version).
// VERSION used to be a hand-edited constant: a version bump that forgot it made every acceptance row
// fail with a message that did not name the cause. It must follow the root package.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');

test('the acceptance VERSION is the root package.json version', async () => {
  const { VERSION } = await import('../../scripts/beta-acceptance-lib.mjs');
  assert.equal(VERSION, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});

test('a version bump needs no edit of the acceptance harness', async t => {
  // A copy of this checkout's scripts beside a package.json one prerelease ahead, as after a bump.
  const bumped = mkdtempSync(path.join(os.tmpdir(), 'alp-bumped-'));
  t.after(() => rmSync(bumped, { recursive: true, force: true }));
  cpSync(path.join(root, 'scripts'), path.join(bumped, 'scripts'), { recursive: true, filter: source => !source.includes('node_modules') });
  const version = '0.0.1-bump.999';
  writeFileSync(path.join(bumped, 'package.json'), JSON.stringify({ name: '@anhlp/alp', private: true, version }));
  const { VERSION } = await import(pathToFileURL(path.join(bumped, 'scripts/beta-acceptance-lib.mjs')).href);
  assert.equal(VERSION, version, 'scripts/beta-acceptance-lib.mjs does not follow package.json: a bump would fail every acceptance row');
});
