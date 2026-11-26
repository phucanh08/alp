#!/usr/bin/env node
// t-cc9e: teamV1 in packages/core/src/upgrade.ts is append-only. A project is upgraded only when the
// role definition it holds is listed there, so a hash that leaves the list strands every project
// holding that content as customInstructions for ever. This module reads the lists teamV1 has had on
// main, for teamv1-history.test.ts and for refreshing fixtures/teamv1-history.json:
//
//   node packages/core/tests/teamv1-history.ts > packages/core/tests/fixtures/teamv1-history.json
//
// (needs a full clone: `git fetch --unshallow origin` in a shallow one). Refreshing only ever adds
// hashes; the test refuses a snapshot that lost one.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
/** Every path upgrade.js has lived at on main, newest first. */
export const UPGRADE_PATHS = ['packages/core/src/upgrade.ts', 'packages/core/src/upgrade.js', 'src/core/upgrade.js'];

/** The teamV1 object literal of one upgrade.js text: { path: [hash, …] } in source order; undefined when it has none. */
/** teamV1: each role definition's path and the hashes of every version of it an upgrade replaces. */
export type TeamLists = Record<string, string[]>;
/** What mainHistory found: teamV1 at each commit of main that touched upgrade.js, or why there is none. */
export type MainHistory =
  | { available: false, reason: string }
  | { available: true, ref: string, history: Array<{ commit: string, file: string | undefined, lists: TeamLists }> };

export function parseTeamV1(text: string): TeamLists | undefined {
  const start = text.indexOf('const teamV1 = {');
  if (start < 0) return undefined;
  const end = text.indexOf('\n};', start);
  if (end < 0) throw new Error('teamV1 literal has no closing "};" line');
  const body = text.slice(start + 'const teamV1 = {'.length, end).replace(/\/\/[^\n]*/g, '');
  const lists: TeamLists = {};
  let key: string | undefined;
  for (const [, value, colon] of body.matchAll(/'([^'\n]*)'\s*(:)?/g)) {
    if (colon) lists[key = value!] = [];
    else if (key !== undefined && /^[0-9a-f]{64}$/.test(value!)) lists[key]!.push(value!);
    else throw new Error(`unexpected string in teamV1: '${value}'`);
  }
  return lists;
}

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * teamV1 at every commit of main's first-parent history that touched upgrade.js, oldest first.
 * Main is origin/main when the clone has it (a CI checkout of a pull request is a merge ref whose
 * first parent is main), else HEAD. `{ available: false, reason }` when there is no usable history.
 */
export function mainHistory(): MainHistory {
  try {
    if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') return { available: false, reason: 'the clone is shallow' };
  } catch (error) {
    return { available: false, reason: `git failed: ${(error as Error).message.split('\n')[0]}` };
  }
  let ref: string | undefined;
  try { ref = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}').trim(); } catch { ref = undefined; }
  try {
    ref ||= git('rev-parse', '--verify', 'HEAD^{commit}').trim();
    const commits = git('rev-list', '--first-parent', '--reverse', ref, '--', ...UPGRADE_PATHS).split('\n').filter(Boolean);
    const history: Array<{ commit: string, file: string | undefined, lists: TeamLists }> = [];
    for (const commit of commits) {
      const file = UPGRADE_PATHS.find(candidate => {
        try { git('cat-file', '-e', `${commit}:${candidate}`); return true; } catch { return false; }
      });
      const lists = file && parseTeamV1(git('show', `${commit}:${file}`));
      if (lists) history.push({ commit, file, lists });
    }
    return { available: true, ref, history };
  } catch (error) {
    if (!('status' in (error as object))) throw error; // a teamV1 this parser cannot read fails, never skips
    return { available: false, reason: `git failed: ${(error as Error).message.split('\n')[0]}` };
  }
}

/** Every hash any commit in `history` listed, by path, in first-seen order. */
export function union(history: Array<{ lists: TeamLists }>) {
  const all: TeamLists = {};
  for (const { lists } of history) {
    for (const [name, hashes] of Object.entries(lists)) {
      all[name] ??= [];
      for (const hash of hashes) if (!all[name]!.includes(hash)) all[name]!.push(hash);
    }
  }
  return all;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = mainHistory();
  if (!main.available) throw new Error(`no main history to snapshot: ${main.reason}`);
  const hashes = union(main.history);
  process.stdout.write(`${JSON.stringify({
    about: 'Every teamV1 hash ever on main (t-cc9e). Append-only: regenerate with node packages/core/tests/teamv1-history.ts',
    through: main.ref,
    hashes,
  }, null, 2)}\n`);
}
