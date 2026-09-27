// alp-rename-keep-file: the fake upstream in this suite is written with upstream names.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlan, planRename } from "./apply-rename.mjs";
import { syncUpstream } from "./sync-upstream.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function configure(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "test");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "core.hooksPath", "/dev/null");
}

function write(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const HOME_FILE = [
  'export const HOME_ENV = "PASEO_HOME";',
  "export function resolvePaseoHome() {",
  '  return "~/.paseo";',
  "}",
  "",
].join("\n");

// A fake upstream with paseo names, and a fork that renamed it and added one commit of its own.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-sync-upstream-"));
  const upstream = path.join(dir, "upstream");
  fs.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  configure(upstream);
  write(upstream, "packages/server/src/paseo-home.ts", HOME_FILE);
  write(upstream, "README.md", "Paseo lives at https://github.com/getpaseo/paseo\n");
  write(upstream, "package.json", '{ "name": "@getpaseo/server" }\n');
  write(upstream, "LICENSE", "Copyright Paseo contributors\n");
  commitAll(upstream, "upstream base");

  const fork = path.join(dir, "fork");
  git(dir, "clone", "-q", upstream, fork);
  configure(fork);
  git(fork, "remote", "rename", "origin", "upstream");
  applyPlan(fork, planRename(fork));
  commitAll(fork, "rename paseo to alp");
  write(fork, "docs/fork.md", "fork-only doc\n");
  commitAll(fork, "fork feature");
  return { dir, upstream, fork };
}

function plainMergeConflicts(fork) {
  const result = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", "upstream/main"],
    { cwd: fork, encoding: "utf8" },
  );
  return result.stdout.trim().split("\n").slice(1).filter(Boolean);
}

test("merges a later upstream commit through the rename without conflicts", (t) => {
  const { dir, upstream, fork } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(
    upstream,
    "packages/server/src/paseo-home.ts",
    `${HOME_FILE}export function paseoPidPath() {\n  return "paseo.pid";\n}\n`,
  );
  const upstreamHead = commitAll(upstream, "upstream adds a pid path");
  const forkHead = git(fork, "rev-parse", "HEAD");

  // The same merge without the rename conflicts: the fork renamed and rewrote the file.
  git(fork, "fetch", "-q", "upstream");
  assert.notDeepEqual(plainMergeConflicts(fork), []);

  const result = syncUpstream({ root: fork });
  assert.equal(result.status, "merged");
  assert.deepEqual(result.conflicts, []);
  assert.equal(git(fork, "rev-parse", "HEAD^1"), forkHead);
  assert.equal(git(fork, "rev-parse", "HEAD^2"), upstreamHead);
  assert.equal(git(fork, "merge-base", "HEAD", "upstream/main"), upstreamHead);
  assert.equal(git(fork, "status", "--porcelain"), "");

  const home = fs.readFileSync(path.join(fork, "packages/server/src/alp-home.ts"), "utf8");
  assert.equal(
    home,
    [
      'export const HOME_ENV = "ALP_HOME";',
      "export function resolveAlpHome() {",
      '  return "~/.alp";',
      "}",
      "export function alpPidPath() {",
      '  return "alp.pid";',
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(fs.existsSync(path.join(fork, "packages/server/src/paseo-home.ts")), false);
  assert.equal(
    fs.readFileSync(path.join(fork, "README.md"), "utf8"),
    "Alp lives at https://github.com/getpaseo/paseo\n",
  );
  assert.equal(
    fs.readFileSync(path.join(fork, "LICENSE"), "utf8"),
    "Copyright Paseo contributors\n",
  );
  assert.equal(fs.readFileSync(path.join(fork, "docs/fork.md"), "utf8"), "fork-only doc\n");

  assert.equal(syncUpstream({ root: fork }).status, "up-to-date");
});

test("a conflicting upstream edit shows in the dry run and stops the merge with markers", (t) => {
  const { dir, upstream, fork } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const forkHome = fs.readFileSync(path.join(fork, "packages/server/src/alp-home.ts"), "utf8");
  write(fork, "packages/server/src/alp-home.ts", forkHome.replace('"~/.alp"', '"~/.alp-fork"'));
  const forkHead = commitAll(fork, "fork moves the home");
  write(
    upstream,
    "packages/server/src/paseo-home.ts",
    HOME_FILE.replace('"~/.paseo"', '"~/.paseo/home"'),
  );
  write(
    upstream,
    "README.md",
    "Paseo lives at https://github.com/getpaseo/paseo\nNew upstream line\n",
  );
  const upstreamHead = commitAll(upstream, "upstream moves the home too");

  const dryRun = syncUpstream({ root: fork, dryRun: true });
  assert.equal(dryRun.status, "dry-run");
  assert.deepEqual(dryRun.conflicts, ["packages/server/src/alp-home.ts"]);
  assert.equal(git(fork, "rev-parse", "HEAD"), forkHead);
  assert.equal(git(fork, "status", "--porcelain"), "");

  const result = syncUpstream({ root: fork, fetch: false });
  assert.equal(result.status, "conflicts");
  assert.equal(git(fork, "rev-parse", "HEAD"), forkHead);
  assert.equal(git(fork, "rev-parse", "MERGE_HEAD"), upstreamHead);
  assert.equal(
    git(fork, "diff", "--name-only", "--diff-filter=U"),
    "packages/server/src/alp-home.ts",
  );
  const conflicted = fs.readFileSync(path.join(fork, "packages/server/src/alp-home.ts"), "utf8");
  assert.match(
    conflicted,
    /<<<<<<< [^\n]*\n {2}return "~\/\.alp-fork";\n=======\n {2}return "~\/\.alp\/home";\n>>>>>>> /,
  );
  assert.equal(
    fs.readFileSync(path.join(fork, "README.md"), "utf8"),
    "Alp lives at https://github.com/getpaseo/paseo\nNew upstream line\n",
  );

  write(
    fork,
    "packages/server/src/alp-home.ts",
    forkHome.replace('"~/.alp"', '"~/.alp-fork/home"'),
  );
  git(fork, "add", "packages/server/src/alp-home.ts");
  git(fork, "commit", "-q", "--no-edit");
  assert.equal(git(fork, "rev-parse", "HEAD^1"), forkHead);
  assert.equal(git(fork, "rev-parse", "HEAD^2"), upstreamHead);
});

test("refuses to merge over uncommitted changes", (t) => {
  const { dir, upstream, fork } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(upstream, "README.md", "Paseo moved\n");
  commitAll(upstream, "upstream edit");
  write(fork, "docs/fork.md", "dirty\n");
  assert.throws(() => syncUpstream({ root: fork }), /uncommitted changes/);
});
