import { join } from "node:path";

import { getAlpWorktreesRoot, isAlpOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  resolveWorkspaceIdAtPath,
  type ArchiveDependencies,
  type ArchiveScope,
} from "../workspace-archive-service.js";
import type { CreateAlpWorktreeInput, CreateAlpWorktreeResult } from "../alp-worktree-service.js";
import { toWorktreeWireError, type WorktreeWireError } from "../worktree-errors.js";
import type { WorkspaceGitService, WorkspaceGitWorktreeInfo } from "../workspace-git-service.js";

export interface ListAlpWorktreesCommandDependencies {
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
}

export interface ListAlpWorktreesCommandInput {
  cwd: string;
  reason?: string;
}

export async function listAlpWorktreesCommand(
  dependencies: ListAlpWorktreesCommandDependencies,
  input: ListAlpWorktreesCommandInput,
): Promise<WorkspaceGitWorktreeInfo[]> {
  if (input.reason) {
    return dependencies.workspaceGitService.listWorktrees(input.cwd, { reason: input.reason });
  }
  return dependencies.workspaceGitService.listWorktrees(input.cwd);
}

type CreateAlpWorktreeWorkflow<Result extends CreateAlpWorktreeResult> = (
  input: CreateAlpWorktreeInput,
) => Promise<Result>;

export interface CreateAlpWorktreeCommandDependencies<
  Result extends CreateAlpWorktreeResult = CreateAlpWorktreeResult,
> {
  alpHome?: string;
  worktreesRoot?: string;
  createAlpWorktreeWorkflow?: CreateAlpWorktreeWorkflow<Result>;
}

export type CreateAlpWorktreeCommandInput = Omit<CreateAlpWorktreeInput, "alpHome" | "runSetup"> & {
  alpHome?: string;
  worktreesRoot?: string;
};

export type CreateAlpWorktreeCommandResult<Result extends CreateAlpWorktreeResult> =
  | {
      ok: true;
      createdWorktree: Result;
    }
  | {
      ok: false;
      error: WorktreeWireError;
      cause: unknown;
    };

export async function createAlpWorktreeCommand<Result extends CreateAlpWorktreeResult>(
  dependencies: CreateAlpWorktreeCommandDependencies<Result>,
  input: CreateAlpWorktreeCommandInput,
): Promise<CreateAlpWorktreeCommandResult<Result>> {
  try {
    if (!dependencies.createAlpWorktreeWorkflow) {
      throw new Error("Alp worktree service is not configured");
    }

    const createdWorktree = await dependencies.createAlpWorktreeWorkflow({
      ...input,
      runSetup: false,
      alpHome: input.alpHome ?? dependencies.alpHome,
      worktreesRoot: input.worktreesRoot ?? dependencies.worktreesRoot,
    });
    return { ok: true, createdWorktree };
  } catch (error) {
    return {
      ok: false,
      error: toWorktreeWireError(error),
      cause: error,
    };
  }
}

export interface ArchiveCommandDependencies extends Omit<
  ArchiveDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
}

export interface ArchiveCommandInput {
  requestId: string;
  repoRoot?: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  branchName?: string;
  workspaceId?: string;
  scope?: ArchiveScope["kind"];
}

export type ArchiveCommandResult =
  | {
      ok: true;
      removedAgents: string[];
    }
  | {
      ok: false;
      code: "NOT_ALLOWED";
      message: string;
      removedAgents: [];
    };

export async function archiveCommand(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<ArchiveCommandResult> {
  const targetPath = await resolveArchiveTarget(dependencies, input);
  const scope = input.scope ?? "workspace";
  const ownership = await isAlpOwnedWorktreeCwd(targetPath, {
    alpHome: dependencies.alpHome,
    worktreesRoot: dependencies.alpWorktreesBaseRoot,
  });

  if (scope === "worktree") {
    if (!ownership.allowed) {
      return {
        ok: false,
        code: "NOT_ALLOWED",
        message: "Worktree is not an alp-owned worktree",
        removedAgents: [],
      };
    }

    const result = await archiveByScope(dependencies, {
      scope: { kind: "worktree", targetPath },
      requestId: input.requestId,
    });

    return {
      ok: true,
      removedAgents: result.archivedAgentIds,
    };
  }

  const workspaceId =
    input.workspaceId ?? (await resolveWorkspaceIdAtPath(dependencies, targetPath));

  if (!workspaceId) {
    dependencies.sessionLogger?.warn(
      { targetPath },
      "Could not resolve workspace for archive; skipping",
    );
    return {
      ok: true,
      removedAgents: [],
    };
  }

  const result = await archiveByScope(dependencies, {
    scope: { kind: "workspace", workspaceId },
    requestId: input.requestId,
  });

  return {
    ok: true,
    removedAgents: result.archivedAgentIds,
  };
}

async function resolveArchiveTarget(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<string> {
  const repoRoot = input.repoRoot ?? null;
  if (input.worktreePath) {
    return input.worktreePath;
  }

  if (input.worktreeSlug) {
    if (!repoRoot) {
      throw new Error("repoRoot is required when worktreeSlug is supplied");
    }
    return resolveWorktreeSlugPath(dependencies, repoRoot, input.worktreeSlug);
  }

  if (repoRoot && input.branchName) {
    const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
    const match = worktrees.find((entry) => entry.branchName === input.branchName);
    if (!match) {
      throw new Error(`alp worktree not found for branch ${input.branchName}`);
    }
    return match.path;
  }

  throw new Error("worktreePath, worktreeSlug, or repoRoot+branchName is required");
}

async function resolveWorktreeSlugPath(
  dependencies: ArchiveCommandDependencies,
  repoRoot: string,
  worktreeSlug: string,
): Promise<string> {
  const worktreesRoot = await getAlpWorktreesRoot(
    repoRoot,
    dependencies.alpHome,
    dependencies.alpWorktreesBaseRoot,
  );
  return join(worktreesRoot, worktreeSlug);
}
