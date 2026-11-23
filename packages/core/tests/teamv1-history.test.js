// t-cc9e: teamV1 (packages/core/src/upgrade.js) is append-only. A hash that leaves it, removed or
// edited, strands every project holding that role definition as customInstructions, and the guard in
// upgrade.test.js only sees today's templates. These tests hold teamV1 to every list it has had on main:
//
// - the snapshot fixtures/teamv1-history.json, hermetic, always runs. Appending to teamV1 keeps it
//   green without touching the fixture; refresh the fixture now and then (it only grows) with
//     node packages/core/tests/teamv1-history.js > packages/core/tests/fixtures/teamv1-history.json
// - main's git history itself, which also covers hashes appended after the snapshot and a snapshot
//   edited together with teamV1. Without history (a shallow clone) it skips, unless
//   ALP_REQUIRE_TEAMV1_HISTORY=1, which CI's core job sets after a full-depth checkout: there it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shippedRoleHashes } from '../src/upgrade.js';
import { EDITED_AWAY_IN_PR_330, mainHistory, parseTeamV1, union } from './teamv1-history.js';

const snapshot = JSON.parse(await readFile(new URL('fixtures/teamv1-history.json', import.meta.url), 'utf8'));

/** `lists`' hashes that today's teamV1 does not list, as "path hash" lines, ignoring `except`. */
function unlisted(lists, except = {}) {
  return Object.entries(lists).flatMap(([name, hashes]) => hashes
    .filter(hash => !shippedRoleHashes[name]?.includes(hash) && !except[name]?.includes(hash))
    .map(hash => `${name} ${hash}`));
}
const advice = 'teamV1 in packages/core/src/upgrade.js is append-only: put these hashes back, never edit or remove a line';

test('teamV1 parser reads today\'s upgrade.js exactly as the module exports it', async () => {
  const text = await readFile(new URL('../src/upgrade.js', import.meta.url), 'utf8');
  assert.deepEqual(parseTeamV1(text), shippedRoleHashes);
});

test('every teamV1 hash in the history snapshot is still listed (t-cc9e)', () => {
  assert.ok(Object.values(snapshot.hashes).flat().length >= 61, 'the snapshot lost hashes; it only grows');
  assert.deepEqual(unlisted(snapshot.hashes), [], advice);
});

test('the PR #330 exception list is frozen and still needed (t-cc9e)', () => {
  assert.deepEqual(EDITED_AWAY_IN_PR_330, {
    'ALP.md': ['ee64975f96b8f6c9275037d2a19e86407de8354bddd6c49428070efe53ce5c7d', '6562f9c9712a800eb2a20278eb0f2093e5f499494c951984ec163126d3b5def7'],
  }, 'no new exceptions: a hash that was on main stays in teamV1');
  const back = Object.entries(EDITED_AWAY_IN_PR_330).flatMap(([name, hashes]) => hashes.filter(hash => shippedRoleHashes[name]?.includes(hash)));
  assert.deepEqual(back, [], 'listed in teamV1 again: drop it from EDITED_AWAY_IN_PR_330');
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
    for (const line of unlisted(lists, EDITED_AWAY_IN_PR_330)) if (!missing.has(line)) missing.set(line, commit.slice(0, 8));
  }
  assert.deepEqual([...missing].map(([line, commit]) => `${line} (on main since ${commit})`), [], advice);
  // Hashes main had that the snapshot lacks are fine (appended since); report how many, for refreshes.
  const newer = Object.entries(union(main.history)).flatMap(([name, hashes]) => hashes.filter(hash => !snapshot.hashes[name]?.includes(hash) && !EDITED_AWAY_IN_PR_330[name]?.includes(hash)));
  t.diagnostic(`${main.history.length} commits of ${main.ref.slice(0, 8)}; ${newer.length} hash(es) newer than the snapshot`);
});
