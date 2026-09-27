// alp-rename-keep-file: comments name the upstream tokens.
//
// Merges upstream Paseo into the renamed alp branch with the conflict surface of an unrenamed fork.
//
// A plain `git merge upstream/main` sees every paseo → alp rename as an alp-side edit, so each
// upstream change near a renamed token conflicts. Instead this script renames the merge base
// and the upstream tree with scripts/rename-map.mjs (in the object store, no worktree), runs
// `git merge-tree --merge-base=<renamed base> HEAD <renamed upstream>`, and records the result
// as a merge commit with parents (HEAD, upstream). The upstream commit stays a parent, so the
// next sync finds its merge base on upstream again.
//
// Clean merge: one merge commit, fast-forwarded onto the current branch.
// Conflicts: the checkout is left mid-merge (conflict markers, unmerged index, MERGE_HEAD);
// resolve, `git add`, and `git commit` to record the same two-parent merge. Nothing is pushed
// and no existing commit is rewritten.
//
// Usage: node scripts/sync-upstream.mjs [--dry-run] [--ref <ref>] [--remote <name>] [--no-fetch]
//                                       [--root <dir>]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";
import { renamePath, renameText } from "./rename-map.mjs";

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function gitStatus(root, args, options = {}) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, ...options });
}

function readBlobs(root, oids) {
  const blobs = new Map();
  if (oids.length === 0) return blobs;
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${oids.join("\n")}\n`,
    maxBuffer: 1 << 30,
  });
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(10, offset);
    const [oid, , size] = out.subarray(offset, headerEnd).toString("utf8").split(" ");
    const start = headerEnd + 1;
    const end = start + Number(size);
    blobs.set(oid, out.subarray(start, end).toString("utf8"));
    offset = end + 1;
  }
  return blobs;
}

/**
 * Writes the renamed copy of `treeish` to the object store and returns its tree id.
 * Only paths and text blobs that hold `paseo` change; every other entry keeps its object id.
 */
export function renameTree(root, treeish) {
  const entries = git(root, ["ls-tree", "-r", "-z", "--full-tree", treeish])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ");
      return { mode, type, oid, path: line.slice(tab + 1) };
    });

  const grep = gitStatus(root, ["grep", "-I", "-l", "-i", "-z", "paseo", treeish]);
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`git grep failed: ${grep.stderr}`);
  const prefix = `${treeish}:`;
  const textHits = new Set(
    grep.stdout
      .split("\0")
      .filter(Boolean)
      .map((hit) => hit.slice(prefix.length)),
  );

  const candidates = entries.filter((entry) => entry.type === "blob" && textHits.has(entry.path));
  const blobs = readBlobs(root, [...new Set(candidates.map((entry) => entry.oid))]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alp-rename-tree-"));
  try {
    const rewritten = [];
    for (const entry of candidates) {
      const text = blobs.get(entry.oid);
      const next = renameText(text, { path: entry.path }).text;
      if (next === text) continue;
      const file = path.join(scratch, String(rewritten.length));
      fs.writeFileSync(file, next);
      rewritten.push({ entry, file });
    }
    if (rewritten.length > 0) {
      const oids = git(root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
        input: `${rewritten.map((item) => item.file).join("\n")}\n`,
      })
        .trim()
        .split("\n");
      rewritten.forEach((item, index) => {
        item.entry.oid = oids[index];
      });
    }

    const seen = new Map();
    const indexInfo = entries.map((entry) => {
      const newPath = renamePath(entry.path);
      if (seen.has(newPath)) {
        throw new Error(
          `rename collision in ${treeish}: ${seen.get(newPath)} and ${entry.path} -> ${newPath}`,
        );
      }
      seen.set(newPath, entry.path);
      return `${entry.mode} ${entry.oid}\t${newPath}\0`;
    });
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
    git(root, ["update-index", "-z", "--index-info"], { env, input: indexInfo.join("") });
    return git(root, ["write-tree"], { env }).trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseMergeTree(output) {
  const fields = output.split("\0").filter(Boolean);
  const tree = fields[0];
  const conflicts = fields.slice(1).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, oid, stage] = line.slice(0, tab).split(" ");
    return { mode, oid, stage: Number(stage), path: line.slice(tab + 1) };
  });
  return { tree, conflicts };
}

function assertReadyToMerge(root) {
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).trim();
  if (dirty) throw new Error(`working tree has uncommitted changes:\n${dirty}`);
  const mergeHead = git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
  if (fs.existsSync(path.resolve(root, mergeHead)))
    throw new Error("a merge is already in progress");
}

function writeGitFile(root, name, content) {
  fs.writeFileSync(
    path.resolve(root, git(root, ["rev-parse", "--git-path", name]).trim()),
    content,
  );
}

/**
 * Merges `ref` into the current branch through the rename. Returns
 * `{ status: "up-to-date" | "dry-run" | "merged" | "conflicts", conflicts: string[], ... }`.
 */
export function syncUpstream({
  root,
  remote = "upstream",
  ref,
  fetch = true,
  dryRun = false,
  log = () => {},
}) {
  const targetRef = ref ?? `${remote}/main`;
  if (fetch) git(root, ["fetch", remote], { stdio: ["ignore", "ignore", "inherit"] });
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const upstream = git(root, ["rev-parse", `${targetRef}^{commit}`]).trim();
  if (gitStatus(root, ["merge-base", "--is-ancestor", upstream, head]).status === 0) {
    log(`already up to date with ${targetRef} (${upstream.slice(0, 12)})`);
    return { status: "up-to-date", conflicts: [] };
  }
  if (!dryRun) assertReadyToMerge(root);
  const base = git(root, ["merge-base", head, upstream]).trim();

  const unrenamed = git(root, [
    "diff-tree",
    "-r",
    "--name-only",
    "--no-renames",
    head,
    renameTree(root, head),
  ])
    .split("\n")
    .filter(Boolean);
  if (unrenamed.length > 0) {
    log(
      `warning: ${unrenamed.length} file(s) in HEAD still hold names the rename would change; they merge as alp-side edits:`,
    );
    for (const filePath of unrenamed.slice(0, 20)) log(`  ${filePath}`);
  }
  const baseTree = renameTree(root, base);
  const upstreamTree = renameTree(root, upstream);
  const result = gitStatus(root, [
    "merge-tree",
    "--write-tree",
    "-z",
    "--no-messages",
    `--merge-base=${baseTree}`,
    head,
    upstreamTree,
  ]);
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`git merge-tree failed: ${result.stderr}`);
  const { tree, conflicts } = parseMergeTree(result.stdout);
  const conflictedPaths = [...new Set(conflicts.map((entry) => entry.path))];
  const summary = { base, upstream, head, tree, conflicts: conflictedPaths };

  log(
    `merge base ${base.slice(0, 12)}, upstream ${targetRef} ${upstream.slice(0, 12)}, HEAD ${head.slice(0, 12)}`,
  );
  log(`conflicted files: ${conflictedPaths.length}`);
  for (const conflictPath of conflictedPaths) log(`  ${conflictPath}`);
  if (dryRun) return { status: "dry-run", ...summary };

  const message = `Merge ${targetRef} (${upstream.slice(0, 12)}) through the alp rename\n\nscripts/sync-upstream.mjs renamed the merge base and ${targetRef} with scripts/rename-map.mjs\nbefore merging.\n`;
  if (conflictedPaths.length === 0) {
    const commit = git(root, ["commit-tree", tree, "-p", head, "-p", upstream], {
      input: message,
    }).trim();
    git(root, ["merge", "--ff-only", "--quiet", commit]);
    log(`merged: ${commit.slice(0, 12)}`);
    log(
      "if package-lock.json changed, run `npm install --package-lock-only` and commit the result",
    );
    return { status: "merged", commit, ...summary };
  }

  git(root, ["read-tree", "-u", "-m", "HEAD", tree]);
  const zero = "0".repeat(head.length);
  const indexInfo = [
    ...conflictedPaths.map((conflictPath) => `0 ${zero}\t${conflictPath}\0`),
    ...conflicts.map((entry) => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`),
  ];
  git(root, ["update-index", "-z", "--index-info"], { input: indexInfo.join("") });
  writeGitFile(root, "MERGE_HEAD", `${upstream}\n`);
  writeGitFile(root, "MERGE_MODE", "no-ff");
  writeGitFile(
    root,
    "MERGE_MSG",
    `${message}\n# Conflicts:\n${conflictedPaths.map((conflictPath) => `#\t${conflictPath}`).join("\n")}\n`,
  );
  log("stopped with conflicts: resolve the files above, `git add` them, then `git commit`");
  log("if package-lock.json changed, run `npm install --package-lock-only` before committing");
  return { status: "conflicts", ...summary };
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    fetch: true,
    remote: "upstream",
    ref: undefined,
    root: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-fetch") args.fetch = false;
    else if (arg === "--remote") args.remote = argv[++i];
    else if (arg === "--ref") args.ref = argv[++i];
    else if (arg === "--root") args.root = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = git(path.resolve(args.root), ["rev-parse", "--show-toplevel"]).trim();
  const result = syncUpstream({ ...args, root, log: (line) => process.stdout.write(`${line}\n`) });
  process.exitCode = result.status === "conflicts" ? 1 : 0;
}
