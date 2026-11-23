#!/usr/bin/env node
// t-cc9e: teamV1 in packages/core/src/upgrade.js is append-only. A project is upgraded only when the
// role definition it holds is listed there, so a hash that leaves the list strands every project
// holding that content as customInstructions for ever. This module reads the lists teamV1 has had on
// main, for teamv1-history.test.js and for refreshing fixtures/teamv1-history.json:
//
//   node packages/core/tests/teamv1-history.js > packages/core/tests/fixtures/teamv1-history.json
//
// (needs a full clone: `git fetch --unshallow origin` in a shallow one). Refreshing only ever adds
// hashes; the test refuses a snapshot that lost one.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
/** Every path upgrade.js has lived at on main, newest first. */
export const UPGRADE_PATHS = ['packages/core/src/upgrade.js', 'src/core/upgrade.js'];

/**
 * The only hashes ever on main that today's teamV1 does not list. Both were ALP.md contents written
 * and then edited away inside PR #330 before any release: ee64975f… appeared in d5a8738f (kept by
 * c118f5e3), 6562f9c9… replaced it in 80ba6253, and 1cbb15d1 replaced that with 48c6a0f8… (the
 * hash PR #330 merged). Frozen: the test fails if this list grows or an entry reappears in teamV1.
 */
export const EDITED_AWAY_IN_PR_330 = Object.freeze({
  'ALP.md': Object.freeze([
    'ee64975f96b8f6c9275037d2a19e86407de8354bddd6c49428070efe53ce5c7d',
    '6562f9c9712a800eb2a20278eb0f2093e5f499494c951984ec163126d3b5def7',
  ]),
});

/** The teamV1 object literal of one upgrade.js text: { path: [hash, …] } in source order; undefined when it has none. */
export function parseTeamV1(text) {
  const start = text.indexOf('const teamV1 = {');
  if (start < 0) return undefined;
  const end = text.indexOf('\n};', start);
  if (end < 0) throw new Error('teamV1 literal has no closing "};" line');
  const body = text.slice(start + 'const teamV1 = {'.length, end).replace(/\/\/[^\n]*/g, '');
  const lists = {};
  let key;
  for (const [, value, colon] of body.matchAll(/'([^'\n]*)'\s*(:)?/g)) {
    if (colon) lists[key = value] = [];
    else if (key !== undefined && /^[0-9a-f]{64}$/.test(value)) lists[key].push(value);
    else throw new Error(`unexpected string in teamV1: '${value}'`);
  }
  return lists;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * teamV1 at every commit of main's first-parent history that touched upgrade.js, oldest first.
 * Main is origin/main when the clone has it (a CI checkout of a pull request is a merge ref whose
 * first parent is main), else HEAD. `{ available: false, reason }` when there is no usable history.
 */
export function mainHistory() {
  try {
    if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') return { available: false, reason: 'the clone is shallow' };
  } catch (error) {
    return { available: false, reason: `git failed: ${error.message.split('\n')[0]}` };
  }
  let ref;
  try { ref = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}').trim(); } catch { ref = undefined; }
  try {
    ref ||= git('rev-parse', '--verify', 'HEAD^{commit}').trim();
    const commits = git('rev-list', '--first-parent', '--reverse', ref, '--', ...UPGRADE_PATHS).split('\n').filter(Boolean);
    const history = [];
    for (const commit of commits) {
      const file = UPGRADE_PATHS.find(candidate => {
        try { git('cat-file', '-e', `${commit}:${candidate}`); return true; } catch { return false; }
      });
      const lists = file && parseTeamV1(git('show', `${commit}:${file}`));
      if (lists) history.push({ commit, file, lists });
    }
    return { available: true, ref, history };
  } catch (error) {
    if (!('status' in error)) throw error; // a teamV1 this parser cannot read fails, never skips
    return { available: false, reason: `git failed: ${error.message.split('\n')[0]}` };
  }
}

/** Every hash any commit in `history` listed, by path, in first-seen order. */
export function union(history) {
  const all = {};
  for (const { lists } of history) {
    for (const [name, hashes] of Object.entries(lists)) {
      all[name] ??= [];
      for (const hash of hashes) if (!all[name].includes(hash)) all[name].push(hash);
    }
  }
  return all;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = mainHistory();
  if (!main.available) throw new Error(`no main history to snapshot: ${main.reason}`);
  const hashes = union(main.history);
  for (const [name, edited] of Object.entries(EDITED_AWAY_IN_PR_330)) hashes[name] = hashes[name].filter(hash => !edited.includes(hash));
  process.stdout.write(`${JSON.stringify({
    about: 'Every teamV1 hash ever on main (t-cc9e). Append-only: regenerate with node packages/core/tests/teamv1-history.js',
    through: main.ref,
    hashes,
  }, null, 2)}\n`);
}
