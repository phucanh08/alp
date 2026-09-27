// alp-rename-keep-file: reports and messages name the upstream tokens.
//
// Applies scripts/rename-map.mjs to a checkout: rewrites tracked text files, `git mv`s renamed
// paths, and writes a JSON report. `--dry-run` only reports. package-lock.json is never
// rewritten as text; regenerate it with `npm install --package-lock-only` after the rename.
//
// Usage: node scripts/apply-rename.mjs [--dry-run] [--root <dir>] [--report <file>]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";
import { REGENERATED_FILES, renamePath, renameText } from "./rename-map.mjs";

const LOCKFILE_NOTE =
  "package-lock.json is not rewritten as text: run `npm install --package-lock-only` after the rename and commit the result";

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, ...options });
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function listTrackedFiles(root) {
  // `<mode> <oid> <stage>\t<path>` NUL-separated; the mode tells symlinks apart.
  return git(root, ["ls-files", "-s", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      return { mode: entry.slice(0, 6), path: entry.slice(tab + 1) };
    });
}

/** Plans the rename of a checkout without touching it. */
export function planRename(root) {
  const plan = { files: [], moves: [], kept: [], regenerated: [], collisions: [] };
  const targets = new Map();
  for (const { mode, path: filePath } of listTrackedFiles(root)) {
    const newPath = renamePath(filePath);
    if (newPath !== filePath) plan.moves.push({ from: filePath, to: newPath });
    const owner = targets.get(newPath);
    if (owner) plan.collisions.push({ from: filePath, to: newPath, with: owner });
    targets.set(newPath, filePath);

    if (REGENERATED_FILES.includes(filePath)) {
      plan.regenerated.push(filePath);
      continue;
    }
    const absolute = path.join(root, filePath);
    const isSymlink = mode === "120000";
    let text;
    if (isSymlink) {
      text = fs.readlinkSync(absolute);
    } else {
      if (!fs.existsSync(absolute)) continue;
      const buffer = fs.readFileSync(absolute);
      if (isBinary(buffer)) continue;
      text = buffer.toString("utf8");
    }
    const result = renameText(text, { path: filePath });
    for (const hit of result.kept) plan.kept.push({ path: filePath, ...hit });
    if (result.text !== text) {
      plan.files.push({ path: filePath, isSymlink, text: result.text, rewrites: result.rewrites });
    }
  }
  return plan;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

export function buildReport(root, plan, { dryRun }) {
  const rewrites = plan.files.flatMap((file) =>
    file.rewrites.map((hit) => ({ path: file.path, ...hit })),
  );
  return {
    root,
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    dryRun,
    lockfile: LOCKFILE_NOTE,
    totals: {
      filesRewritten: plan.files.length,
      linesRewritten: new Set(rewrites.map((hit) => `${hit.path}:${hit.line}`)).size,
      tokensRewritten: rewrites.length,
      pathsMoved: plan.moves.length,
      keptHits: plan.kept.length,
      collisions: plan.collisions.length,
    },
    keptByRule: countBy(plan.kept, "rule"),
    regenerated: plan.regenerated,
    collisions: plan.collisions,
    moves: plan.moves,
    kept: plan.kept,
    rewrites,
  };
}

/** Writes the planned content, then moves renamed paths with `git mv` and stages the result. */
export function applyPlan(root, plan) {
  if (plan.collisions.length > 0) {
    throw new Error(`rename collisions: ${JSON.stringify(plan.collisions.slice(0, 5))}`);
  }
  for (const file of plan.files) {
    const absolute = path.join(root, file.path);
    if (file.isSymlink) {
      fs.unlinkSync(absolute);
      fs.symlinkSync(file.text, absolute);
    } else {
      fs.writeFileSync(absolute, file.text);
    }
  }
  if (plan.files.length > 0) {
    git(root, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      input: plan.files.map((file) => file.path).join("\0"),
    });
  }
  for (const move of plan.moves) {
    fs.mkdirSync(path.dirname(path.join(root, move.to)), { recursive: true });
    git(root, ["mv", "--", move.from, move.to]);
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, root: process.cwd(), report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--root") args.root = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = git(path.resolve(args.root), ["rev-parse", "--show-toplevel"]).trim();
  const plan = planRename(root);
  const report = buildReport(root, plan, { dryRun: args.dryRun });
  const reportPath = path.resolve(args.report ?? path.join(os.tmpdir(), "alp-rename-report.json"));
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!args.dryRun) applyPlan(root, plan);

  const { totals } = report;
  process.stdout.write(
    [
      `${args.dryRun ? "dry run" : "applied"} at ${report.head.slice(0, 12)} in ${root}`,
      `files rewritten ${totals.filesRewritten}, lines ${totals.linesRewritten}, tokens ${totals.tokensRewritten}`,
      `paths moved ${totals.pathsMoved}, collisions ${totals.collisions}`,
      `kept hits ${totals.keptHits}: ${Object.entries(report.keptByRule)
        .map(([rule, count]) => `${rule} ${count}`)
        .join(", ")}`,
      LOCKFILE_NOTE,
      `report: ${reportPath}`,
      "",
    ].join("\n"),
  );
  return report;
}

if (isMainModule(import.meta.url)) {
  main();
}
