// alp-rename-keep-file: the throwaway checkout in this suite is written with upstream names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlan, main, planRename } from "./apply-rename.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function write(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

const LOCKFILE = '{ "packages": { "node_modules/@getpaseo/server": { "link": true } } }\n';
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x70, 0x61, 0x73, 0x65, 0x6f]);

function makeCheckout(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-apply-rename-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null");
  write(
    dir,
    "packages/server/src/paseo-home.ts",
    'export const home = process.env.PASEO_HOME ?? "~/.paseo";\n',
  );
  write(dir, "packages/server/src/index.ts", 'export { home } from "./paseo-home.js";\n');
  write(dir, "plugins/slp/paseo-plugin.json", '{ "name": "slp" }\n');
  write(dir, "docs/links.md", "Upstream: https://github.com/getpaseo/paseo\n");
  write(dir, "package-lock.json", LOCKFILE);
  write(dir, "packages/audio/package-lock.json", '{ "name": "@getpaseo/audio" }\n');
  write(dir, "LICENSE", "Copyright Paseo\n");
  fs.writeFileSync(path.join(dir, "paseo-logo.png"), BINARY);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

test("dry run reports the rename and leaves the checkout untouched", (t) => {
  const dir = makeCheckout(t);
  const reportPath = path.join(dir, "..", `${path.basename(dir)}-report.json`);
  t.after(() => fs.rmSync(reportPath, { force: true }));
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    main(["--dry-run", "--root", dir, "--report", reportPath]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(git(dir, "status", "--porcelain"), "");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.totals, {
    filesRewritten: 3,
    linesRewritten: 3,
    tokensRewritten: 4,
    pathsMoved: 3,
    keptHits: 2,
    collisions: 0,
  });
  assert.deepEqual(report.moves, [
    { from: "packages/server/src/paseo-home.ts", to: "packages/server/src/alp-home.ts" },
    { from: "paseo-logo.png", to: "alp-logo.png" },
    { from: "plugins/slp/paseo-plugin.json", to: "plugins/slp/alp-plugin.json" },
  ]);
  assert.deepEqual(report.keptByRule, { "upstream-url": 1, license: 1 });
  assert.deepEqual(report.regenerated, ["package-lock.json"]);
  assert.match(report.lockfile, /npm install --package-lock-only/);
});

test("apply rewrites content, moves paths, and skips the lockfile and binaries", (t) => {
  const dir = makeCheckout(t);
  applyPlan(dir, planRename(dir));

  assert.equal(
    fs.readFileSync(path.join(dir, "packages/server/src/alp-home.ts"), "utf8"),
    'export const home = process.env.ALP_HOME ?? "~/.alp";\n',
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "packages/server/src/index.ts"), "utf8"),
    'export { home } from "./alp-home.js";\n',
  );
  assert.ok(fs.existsSync(path.join(dir, "plugins/slp/alp-plugin.json")));
  assert.equal(
    fs.readFileSync(path.join(dir, "docs/links.md"), "utf8"),
    "Upstream: https://github.com/getpaseo/paseo\n",
  );
  assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), LOCKFILE);
  assert.equal(
    fs.readFileSync(path.join(dir, "packages/audio/package-lock.json"), "utf8"),
    '{ "name": "@alp/audio" }\n',
  );
  assert.equal(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), "Copyright Paseo\n");
  assert.deepEqual(fs.readFileSync(path.join(dir, "alp-logo.png")), BINARY);

  assert.equal(git(dir, "diff", "--name-only"), "");
  const staged = git(dir, "diff", "--cached", "--no-renames", "--name-only").split("\n").sort();
  assert.deepEqual(staged, [
    "alp-logo.png",
    "packages/audio/package-lock.json",
    "packages/server/src/alp-home.ts",
    "packages/server/src/index.ts",
    "packages/server/src/paseo-home.ts",
    "paseo-logo.png",
    "plugins/slp/alp-plugin.json",
    "plugins/slp/paseo-plugin.json",
  ]);

  const again = planRename(dir);
  assert.deepEqual([again.files.length, again.moves.length], [0, 0]);
});
