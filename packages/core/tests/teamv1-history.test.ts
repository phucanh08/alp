// t-cc9e: teamV1 (packages/core/src/project/upgrade.ts) is append-only. A hash that leaves it, removed or
// edited, strands every project holding that role definition as customInstructions, and the guard in
// upgrade.test.ts only sees today's templates. These tests hold teamV1 to every list it has had on main:
//
// - the snapshot fixtures/teamv1-history.json, hermetic, always runs. Appending to teamV1 keeps it
//   green without touching the fixture; refresh the fixture now and then (it only grows) with
//     node packages/core/tests/teamv1-history.ts > packages/core/tests/fixtures/teamv1-history.json
// - main's git history itself, which also covers hashes appended after the snapshot and a snapshot
//   edited together with teamV1. Without history (a shallow clone) it skips, unless
//   ALP_REQUIRE_TEAMV1_HISTORY=1, which CI's core job sets after a full-depth checkout: there it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shippedRoleHashes } from '@anhlp/alp-core/upgrade';
import { mainHistory, parseTeamV1, union } from './teamv1-history.ts';
import type { TeamLists } from './teamv1-history.ts';

const snapshot = JSON.parse(await readFile(new URL('fixtures/teamv1-history.json', import.meta.url), 'utf8'));

/** `lists`' hashes that today's teamV1 does not list, as "path hash" lines. */
function unlisted(lists: TeamLists) {
  return Object.entries(lists).flatMap(([name, hashes]) => hashes
    .filter(hash => !(shippedRoleHashes as TeamLists)[name]?.includes(hash))
    .map(hash => `${name} ${hash}`));
}
const advice = 'teamV1 in packages/core/src/project/upgrade.ts is append-only: put these hashes back, never edit or remove a line';

test('teamV1 parser reads today\'s upgrade.js exactly as the module exports it', async () => {
  const text = await readFile(new URL('../src/project/upgrade.ts', import.meta.url), 'utf8');
  assert.deepEqual(parseTeamV1(text), shippedRoleHashes);
});

test('every teamV1 hash in the history snapshot is still listed (t-cc9e)', () => {
  assert.ok(Object.values(snapshot.hashes).flat().length >= 63, 'the snapshot lost hashes; it only grows');
  assert.deepEqual(unlisted(snapshot.hashes), [], advice);
});

test('every teamV1 hash ever on main is still listed (t-cc9e, git history)', t => {
  const main = mainHistory();
  if (!main.available) {
    const message = `main's history of upgrade.js is unavailable (${main.reason})`;
    if (process.env.ALP_REQUIRE_TEAMV1_HISTORY === '1') assert.fail(`${message}; ALP_REQUIRE_TEAMV1_HISTORY=1 needs a full-depth checkout (fetch-depth: 0)`);
    t.skip(`${message}; the snapshot test still guards`);
    return;
  }
  assert.ok(main.history.length > 0, `no commit of ${main.ref} has a teamV1 in upgrade.js`);
  const missing = new Map(); // "path hash" -> first main commit that listed it
  for (const { commit, lists } of main.history) {
    for (const line of unlisted(lists)) if (!missing.has(line)) missing.set(line, commit.slice(0, 8));
  }
  assert.deepEqual([...missing].map(([line, commit]) => `${line} (on main since ${commit})`), [], advice);
  // Hashes main had that the snapshot lacks are fine (appended since); report how many, for refreshes.
  const newer = Object.entries(union(main.history)).flatMap(([name, hashes]) => hashes.filter((hash: string) => !snapshot.hashes[name]?.includes(hash)));
  t.diagnostic(`${main.history.length} commits of ${main.ref.slice(0, 8)}; ${newer.length} hash(es) newer than the snapshot`);
});
