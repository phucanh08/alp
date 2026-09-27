import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { z } from "zod";

const ChangeRequestLookupTargetSchema = z.object({
  headRef: z.string().min(1),
  headRepositoryOwner: z.string().min(1).optional(),
  changeRequestNumber: z.number().int().positive().optional(),
  localBranchName: z.string().min(1).optional(),
});

// baseRefName is the display name; baseRef is the exact ref the worktree was cut from
// ("refs/remotes/upstream/main"). baseRef is optional because worktrees written before it
// existed only have the name — there are no migrations, so readers fall back.
const AlpWorktreeMetadataV1Schema = z.object({
  version: z.literal(1),
  baseRefName: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  changeRequestLookupTarget: ChangeRequestLookupTargetSchema.optional(),
});

const AlpWorktreeMetadataV2Schema = z.object({
  version: z.literal(2),
  baseRefName: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  changeRequestLookupTarget: ChangeRequestLookupTargetSchema.optional(),
  firstAgentBranchAutoName: z
    .discriminatedUnion("status", [
      z.object({
        status: z.literal("pending"),
        placeholderBranchName: z.string().min(1),
      }),
      z.object({
        status: z.literal("attempted"),
        placeholderBranchName: z.string().min(1),
        attemptedAt: z.string().min(1),
      }),
    ])
    .optional(),
  runtime: z
    .object({
      worktreePort: z.number().int().positive(),
    })
    .optional(),
});

const AlpWorktreeMetadataSchema = z.union([
  AlpWorktreeMetadataV1Schema,
  AlpWorktreeMetadataV2Schema,
]);

export type AlpWorktreeMetadata = z.infer<typeof AlpWorktreeMetadataSchema>;
export type AlpWorktreeChangeRequestHint = z.infer<typeof ChangeRequestLookupTargetSchema>;

export function createAlpWorktreeChangeRequestHint(
  input: AlpWorktreeChangeRequestHint,
): AlpWorktreeChangeRequestHint {
  return ChangeRequestLookupTargetSchema.parse(input);
}

export function getAlpWorktreeChangeRequestHintForBranch(
  metadata: AlpWorktreeMetadata | null,
  currentBranch: string,
): AlpWorktreeChangeRequestHint | null {
  const target = metadata?.changeRequestLookupTarget;
  if (!target) {
    return null;
  }
  if (target.localBranchName) {
    return target.localBranchName === currentBranch ? target : null;
  }

  // COMPAT(change-request-local-branch): metadata before v0.2.5 omitted the
  // local binding; remove after 2027-07-31.
  const canonicalBranches = new Set<string>();
  if (target.headRepositoryOwner) {
    canonicalBranches.add(`${target.headRepositoryOwner}/${target.headRef}`);
    const normalizedOwner = normalizeLegacyGitHubOwnerForBranch(target.headRepositoryOwner);
    if (normalizedOwner) {
      canonicalBranches.add(`${normalizedOwner}/${target.headRef}`);
    }
  } else {
    canonicalBranches.add(target.headRef);
  }
  return canonicalBranches.has(currentBranch) ? target : null;
}

function normalizeLegacyGitHubOwnerForBranch(owner: string): string | null {
  const normalized = owner.trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

export function rebindAlpWorktreeChangeRequestHint(
  worktreeRoot: string,
  previousBranch: string,
  currentBranch: string,
): boolean {
  const metadata = readAlpWorktreeMetadata(worktreeRoot);
  const target = getAlpWorktreeChangeRequestHintForBranch(metadata, previousBranch);
  if (!metadata || !target) {
    return false;
  }

  writeAlpWorktreeMetadataFile(worktreeRoot, {
    ...metadata,
    changeRequestLookupTarget: {
      ...target,
      ...(target.headRef === previousBranch &&
      !target.headRepositoryOwner &&
      target.changeRequestNumber === undefined
        ? { headRef: currentBranch }
        : {}),
      localBranchName: currentBranch,
    },
  });
  return true;
}

export function pinAlpWorktreeBranchIdentityIfMissing(
  worktreeRoot: string,
  branch: string,
): boolean {
  const metadata = readAlpWorktreeMetadata(worktreeRoot);
  if (!metadata || metadata.changeRequestLookupTarget) {
    return false;
  }
  const target = createAlpWorktreeChangeRequestHint({
    headRef: branch,
    localBranchName: branch,
  });
  writeAlpWorktreeMetadataFile(worktreeRoot, {
    ...metadata,
    changeRequestLookupTarget: target,
  });
  return true;
}

function getGitDirForWorktreeRoot(worktreeRoot: string): string {
  const gitPath = join(worktreeRoot, ".git");
  if (!existsSync(gitPath)) {
    throw new Error(`Not a git repository: ${worktreeRoot}`);
  }

  // In a worktree checkout, `.git` is a file containing `gitdir: <path>`.
  // In a normal checkout, `.git` is a directory.
  try {
    const gitFileContent = readFileSync(gitPath, "utf8");
    const match = gitFileContent.match(/gitdir:\s*(.+)/);
    if (match?.[1]) {
      const raw = match[1].trim();
      return isAbsolute(raw) ? raw : resolve(worktreeRoot, raw);
    }
  } catch {
    // If `.git` is a directory, readFileSync will throw; fall through.
  }

  return gitPath;
}

export function getAlpWorktreeMetadataPath(worktreeRoot: string): string {
  const gitDir = getGitDirForWorktreeRoot(worktreeRoot);
  return join(gitDir, "alp", "worktree.json");
}

export function isQualifiedRef(ref: string): boolean {
  return ref.trim().startsWith("refs/");
}

const REMOTE_TRACKING_PREFIX = "refs/remotes/";

/**
 * The human-readable branch name behind a ref. Display and legacy identity only — it cannot
 * round-trip, so anything that has to resolve to a commit keeps the exact ref instead.
 *
 * refs/remotes/<remote>/<branch> works for any remote, not just origin. Git allows slashes in
 * remote names, so refs/remotes/a/b/c is ambiguous and the first segment is read as the
 * remote: slashes are everywhere in branch names and rare in remote names. A remote genuinely
 * named "team/upstream" therefore displays as "upstream/main" rather than "main"; the exact
 * ref is unaffected, which is why this is display-only.
 */
export function branchNameFromRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  if (trimmed.startsWith(REMOTE_TRACKING_PREFIX)) {
    const remainder = trimmed.slice(REMOTE_TRACKING_PREFIX.length);
    const separator = remainder.indexOf("/");
    return separator === -1 ? remainder : remainder.slice(separator + 1);
  }
  // Short form. It cannot be generalized to any remote the way the qualified form can:
  // without the remote list, "feature/x" is indistinguishable from "<remote>/x".
  if (trimmed.startsWith("origin/")) {
    return trimmed.slice("origin/".length);
  }
  return trimmed;
}

export function normalizeBaseRefName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Base branch is required");
  }
  return branchNameFromRef(trimmed);
}

function assertValidBaseRef(value: string): void {
  if (value === "HEAD") {
    throw new Error("Base branch cannot be HEAD");
  }
  if (value.includes("..") || value.includes("@{")) {
    throw new Error(`Invalid base branch: ${value}`);
  }
}

export function writeAlpWorktreeMetadata(
  worktreeRoot: string,
  options: {
    baseRefName: string;
    baseRef?: string;
    changeRequestLookupTarget?: AlpWorktreeChangeRequestHint;
  },
): void {
  const baseRefName = normalizeBaseRefName(options.baseRefName);
  assertValidBaseRef(baseRefName);
  const baseRef = options.baseRef?.trim();
  if (baseRef) {
    assertValidBaseRef(baseRef);
  }

  const metadata: AlpWorktreeMetadata = {
    version: 1,
    baseRefName,
    ...(baseRef ? { baseRef } : {}),
    ...(options.changeRequestLookupTarget
      ? { changeRequestLookupTarget: options.changeRequestLookupTarget }
      : {}),
  };
  writeAlpWorktreeMetadataFile(worktreeRoot, metadata);
}

export function writeAlpWorktreeRuntimeMetadata(
  worktreeRoot: string,
  options: { worktreePort: number },
): void {
  if (!Number.isInteger(options.worktreePort) || options.worktreePort <= 0) {
    throw new Error(`Invalid worktree runtime port: ${options.worktreePort}`);
  }

  const current = readAlpWorktreeMetadata(worktreeRoot);
  if (!current) {
    throw new Error("Cannot persist worktree runtime metadata: missing base metadata");
  }

  const next: AlpWorktreeMetadata = {
    ...current,
    version: 2,
    runtime: {
      worktreePort: options.worktreePort,
    },
  };
  writeAlpWorktreeMetadataFile(worktreeRoot, next);
}

export function writeAlpWorktreeFirstAgentBranchAutoNameMetadata(
  worktreeRoot: string,
  options: { placeholderBranchName: string },
): void {
  const placeholderBranchName = options.placeholderBranchName.trim();
  if (!placeholderBranchName) {
    throw new Error("Placeholder branch name is required");
  }

  const current = readAlpWorktreeMetadata(worktreeRoot);
  if (!current) {
    throw new Error("Cannot persist first-agent branch auto-name metadata: missing base metadata");
  }

  writeAlpWorktreeMetadataFile(worktreeRoot, {
    ...current,
    version: 2,
    firstAgentBranchAutoName: {
      status: "pending",
      placeholderBranchName,
    },
  });
}

export function markAlpWorktreeFirstAgentBranchAutoNameAttempted(
  worktreeRoot: string,
  options: { attemptedAt?: string } = {},
): AlpWorktreeMetadata | null {
  const current = readAlpWorktreeMetadata(worktreeRoot);
  if (!current || current.version !== 2 || current.firstAgentBranchAutoName?.status !== "pending") {
    return current;
  }

  const next: AlpWorktreeMetadata = {
    ...current,
    firstAgentBranchAutoName: {
      status: "attempted",
      placeholderBranchName: current.firstAgentBranchAutoName.placeholderBranchName,
      attemptedAt: options.attemptedAt ?? new Date().toISOString(),
    },
  };
  writeAlpWorktreeMetadataFile(worktreeRoot, next);
  return next;
}

export function readAlpWorktreeMetadata(worktreeRoot: string): AlpWorktreeMetadata | null {
  const metadataPath = getAlpWorktreeMetadataPath(worktreeRoot);
  if (!existsSync(metadataPath)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  return AlpWorktreeMetadataSchema.parse(parsed);
}

export function requireAlpWorktreeBaseRefName(worktreeRoot: string): string {
  const metadataPath = getAlpWorktreeMetadataPath(worktreeRoot);
  const metadata = readAlpWorktreeMetadata(worktreeRoot);
  if (!metadata) {
    throw new Error(`Missing alp worktree base metadata: ${metadataPath}`);
  }
  return metadata.baseRefName;
}

export function readAlpWorktreeRuntimePort(worktreeRoot: string): number | null {
  const metadata = readAlpWorktreeMetadata(worktreeRoot);
  if (!metadata) {
    return null;
  }
  if (metadata.version === 2 && metadata.runtime?.worktreePort) {
    return metadata.runtime.worktreePort;
  }
  return null;
}

function writeAlpWorktreeMetadataFile(worktreeRoot: string, metadata: AlpWorktreeMetadata): void {
  const metadataPath = getAlpWorktreeMetadataPath(worktreeRoot);
  mkdirSync(join(getGitDirForWorktreeRoot(worktreeRoot), "alp"), { recursive: true });
  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(tempPath, metadataPath);
}
