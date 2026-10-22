// @ts-check
import { blockedFilePath } from '@anhlp/alp-protocol';
import { describe } from './errors.js';
import { can, grantedWorkspace } from './gateway.js';
import { relativeFilePath } from './file-tree.js';

/**
 * Paseo's Changes and Diff panels, read only (docs/protocol/alp-json-rpc-v1.md §12.5, issue #121
 * G1): what the app needs to show a workspace's Git status and diff without React. The status
 * (branch, changed files) needs the host's `workspace.git` and the token's `project.read`; the
 * diff's hunks are file content and also need `files.read`, never a default grant. Both name the
 * workspace by its registry id, so the workspace must be registered on the host.
 */

/** Why the panels show what they show, in the words the user reads. */
export const GIT_MESSAGES = Object.freeze({
  capability: 'This host does not offer Git changes. Update ALP on the host.',
  registry: 'This host does not list its workspaces, so Git changes cannot be shown. Update ALP on the host.',
  projectRead: 'This access token cannot read Git status (needs project.read).',
  filesRead: 'This access token cannot read file contents, so diffs are hidden (needs files.read).',
  workspace: 'Choose a workspace to see its changes.',
  unregistered: 'This workspace is not registered on the host, so its Git changes cannot be shown. The host owner can add it as a project.',
  loading: 'Loading workspaces…',
});

/** Refusals of workspace.git.status and diff, by data.reason (§12.5). */
export const GIT_ERROR_MESSAGES = Object.freeze({
  not_repository: 'Not a git repository',
  unknown_ref: 'The base branch is not known in this repository.',
  invalid_compare: 'The host refused this comparison. Pick Uncommitted or a branch name Git accepts.',
  stale_snapshot: 'The checkout changed since this list was loaded. It was loaded again from the start.',
  invalid_cursor: 'The rest of this list is no longer available. It was loaded again from the start.',
  git_unavailable: 'Git is not available on the host.',
  git_failed: 'Git failed on the host. Try again; the host\'s logs may say why.',
  blocked_path: 'This file is never shown remotely: secrets, keys, .git and ALP configuration are blocked.',
  invalid_path: 'That is not a valid path in this workspace.',
});

/**
 * Paseo's diff modes: Uncommitted (HEAD against the working tree, untracked files included) and
 * Committed, the branch against its base (`base` in §12.5). Staged and unstaged are the host's too.
 */
export const GIT_MODES = Object.freeze([
  { id: 'uncommitted', label: 'Uncommitted' },
  { id: 'base', label: 'Committed' },
  { id: 'staged', label: 'Staged' },
  { id: 'unstaged', label: 'Unstaged' },
]);

/** What each change is called, as Paseo's file headers (New, Deleted, Modified) and the rest. */
export const CHANGE_LABELS = Object.freeze({
  modified: 'Modified', added: 'New', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied',
  typechange: 'Type changed', untracked: 'Untracked', conflicted: 'Conflicted',
});
/** The one-letter badge of each change in the file list. */
export const CHANGE_LETTERS = Object.freeze({
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflicted: '!',
});

/** Why a file of a diff has no hunks, as Paseo says it for binary and too large files. */
export const KIND_MESSAGES = Object.freeze({
  binary: 'Binary file',
  too_large: 'Diff too large to display',
  withheld: 'Content withheld: it looks like it holds a private key.',
  symlink: 'Symbolic link: its target is not shown.',
  submodule: 'Submodule: its content is not shown.',
});

/** A failure of a Git request: the Failure (code, reason, message) the panels show. */
export class GitAccessError extends Error {
  /** @param {import('./errors.js').Failure} failure */
  constructor(failure) {
    super(failure.message);
    this.name = 'GitAccessError';
    this.failure = failure;
    this.reason = failure.reason;
  }
}

/** describe() for a Git request: the reasons of §12.5 get their own words. @param {unknown} error @returns {import('./errors.js').Failure} */
export function describeGitError(error) {
  if (error instanceof GitAccessError) return error.failure;
  const failure = describe(error);
  if (failure.code === 1003 && failure.reason === 'grant') {
    const permission = /** @type {any} */ (error)?.data?.permission;
    if (permission === 'files.read') return { ...failure, message: GIT_MESSAGES.filesRead };
    if (permission === 'project.read') return { ...failure, message: GIT_MESSAGES.projectRead };
    return failure;
  }
  const known = failure.reason ? /** @type {Record<string, string>} */ (GIT_ERROR_MESSAGES)[failure.reason] : undefined;
  return known ? { ...failure, message: known } : failure;
}

/** Whether a failure means "start the list again" (the checkout changed, or the cursor is gone). @param {unknown} error */
export function restartsDiff(error) {
  const failure = describeGitError(error);
  return (failure.code === 1004 && failure.reason === 'stale_snapshot') || (failure.code === -32602 && failure.reason === 'invalid_cursor');
}

/**
 * The registry workspace of the open workspace path: the rows whose directory is the path, or
 * its canonical path as the grant names it, not archived; pinned first, then oldest (as the
 * sidebar lists them). Undefined when the host has none.
 * @param {{ principal: import('./gateway.js').Principal | null, workspace: string | null, registry: { workspaces: import('@anhlp/alp-protocol').RegistryWorkspace[] } }} state
 */
export function registryWorkspaceOf(state) {
  const path = state.workspace;
  if (!path) return undefined;
  const root = grantedWorkspace(state.principal ?? undefined, path);
  const names = new Set([path, ...(root ? [root.path, root.canonical] : [])]);
  return state.registry.workspaces
    .filter(row => names.has(row.directory) && !row.archivedAt)
    .sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))[0];
}

/**
 * What the panels may show (the guards in the controller's order): `status` when the status can
 * be read, else why not; `content` whether diffs (hunks) can be read too, else `contentMessage`.
 * @param {{ connection: { capabilities: string[] }, principal: import('./gateway.js').Principal | null, workspace: string | null, registry: { workspaces: import('@anhlp/alp-protocol').RegistryWorkspace[], loading?: boolean } }} state
 * @returns {{ status: true, workspaceId: string, content: boolean, contentMessage?: string } | { status: false, reason: 'workspace' | 'capability' | 'projectRead' | 'registry' | 'loading' | 'unregistered', message: string }}
 */
export function gitAccess(state) {
  const refuse = (/** @type {'workspace' | 'capability' | 'projectRead' | 'registry' | 'loading' | 'unregistered'} */ reason) => ({ status: /** @type {const} */ (false), reason, message: GIT_MESSAGES[reason] });
  if (!state.workspace) return refuse('workspace');
  if (!state.connection.capabilities.includes('workspace.git')) return refuse('capability');
  if (!can(state.principal ?? undefined, 'project.read')) return refuse('projectRead');
  if (!state.connection.capabilities.includes('workspace.registry')) return refuse('registry');
  const row = registryWorkspaceOf(state);
  if (!row) return refuse(state.registry.loading ? 'loading' : 'unregistered');
  const content = can(state.principal ?? undefined, 'files.read');
  return { status: true, workspaceId: row.id, content, ...(content ? {} : { contentMessage: GIT_MESSAGES.filesRead }) };
}

/** A path for workspace.git.diff's `path`: relative and not blocked, else undefined. @param {unknown} path */
export function gitRequestPath(path) {
  const relative = typeof path === 'string' && path ? relativeFilePath(path) : undefined;
  return relative && !blockedFilePath(relative) ? relative : undefined;
}

/**
 * The comparison to ask for: the mode, a base branch only for `base` (none: the status's
 * default), ignoreWhitespace only when set.
 * @param {{ mode: string, baseRef?: string | null, ignoreWhitespace?: boolean }} input
 * @returns {import('@anhlp/alp-protocol').GitCompare}
 */
export function gitCompare({ mode, baseRef, ignoreWhitespace }) {
  const known = GIT_MODES.some(entry => entry.id === mode) ? /** @type {import('@anhlp/alp-protocol').GitCompare['mode']} */ (mode) : 'uncommitted';
  return { mode: known, ...(known === 'base' && baseRef ? { baseRef } : {}), ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}) };
}

/**
 * The diff as loaded so far: pages appended in order, hidden counts summed; the last page's
 * cursor continues it. A page of another snapshot starts it again.
 * @typedef {{ compare: import('@anhlp/alp-protocol').GitDiffPage['compare'], snapshot: string, files: import('@anhlp/alp-protocol').GitDiffFile[], hiddenCount: number, truncated: boolean, nextCursor?: string }} DiffView
 * @param {DiffView | undefined} current @param {import('@anhlp/alp-protocol').GitDiffPage} page
 * @returns {DiffView}
 */
export function appendDiffPage(current, page) {
  const files = Array.isArray(page?.files) ? page.files : [];
  const hidden = Number.isSafeInteger(page?.hiddenCount) && page.hiddenCount > 0 ? page.hiddenCount : 0;
  const base = current && current.snapshot === page.snapshot ? current : undefined;
  return {
    compare: page.compare,
    snapshot: page.snapshot,
    files: base ? [...base.files, ...files] : [...files],
    hiddenCount: (base?.hiddenCount ?? 0) + hidden,
    truncated: page.truncated === true,
    ...(typeof page.nextCursor === 'string' && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * A file's hunks as rows to draw: a hunk header (Git's range line with its context), then its lines with
 * their old and new line numbers; `noNewline` marks a line Git says ends the file without one.
 * @param {import('@anhlp/alp-protocol').GitDiffFile} file
 * @returns {Array<{ type: 'hunk', text: string } | { type: 'add' | 'remove' | 'context', text: string, oldLine?: number, newLine?: number, noNewline?: boolean }>}
 */
export function diffRows(file) {
  /** @type {ReturnType<typeof diffRows>} */
  const rows = [];
  for (const hunk of Array.isArray(file?.hunks) ? file.hunks : []) {
    rows.push({ type: 'hunk', text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.context ? ` ${hunk.context}` : ''}` });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      const noNewline = line.noNewline === true ? { noNewline: true } : {};
      if (line.type === 'add') rows.push({ type: 'add', text: line.content, newLine: newLine++, ...noNewline });
      else if (line.type === 'remove') rows.push({ type: 'remove', text: line.content, oldLine: oldLine++, ...noNewline });
      else rows.push({ type: 'context', text: line.content, oldLine: oldLine++, newLine: newLine++, ...noNewline });
    }
  }
  return rows;
}

/** Additions and deletions of a list of diff files. @param {Array<{ additions: number, deletions: number }>} files */
export function diffTotals(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) { additions += file.additions || 0; deletions += file.deletions || 0; }
  return { additions, deletions };
}

/** A count as Paseo's formatDiffCount: 1.2k past a thousand. @param {number} value */
export function formatDiffCount(value) {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.floor(value || 0)));
  const thousands = value / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}

/**
 * The branch header's text: the branch (or "Detached at <short head>"), its upstream and how far
 * it is ahead/behind, the base it compares to.
 * @param {import('@anhlp/alp-protocol').GitStatus} status
 */
export function branchLine(status) {
  const name = status.branch ?? (status.detached && status.head ? `Detached at ${status.head.slice(0, 7)}` : status.head ? status.head.slice(0, 7) : 'No commits yet');
  const parts = [name];
  if (status.upstream) {
    const { ref, ahead, behind } = status.upstream;
    parts.push(`${ref}${ahead || behind ? ` (${[ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ')})` : ''}`);
  }
  return parts.join(' · ');
}

/** The base a Committed diff compares to, as Paseo's computeBaseRefLabel. @param {string | null | undefined} baseRef */
export function baseLabel(baseRef) {
  return baseRef ? baseRef.replace(/^refs\/(heads|remotes)\//, '').trim() : 'base';
}
