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
  declare failure: import('./errors.js').Failure;
  declare reason: string | undefined;
  constructor(failure: import('./errors.js').Failure) {
    super(failure.message);
    this.name = 'GitAccessError';
    this.failure = failure;
    this.reason = failure.reason;
  }
}

/** describe() for a Git request: the reasons of §12.5 get their own words. */
export function describeGitError(error: unknown): import('./errors.js').Failure {
  if (error instanceof GitAccessError) return error.failure;
  const failure = describe(error);
  if (failure.code === 1003 && failure.reason === 'grant') {
    // any: a thrown value of unknown shape; only optional fields are read, each checked before use.
    const permission = (error as any)?.data?.permission;
    if (permission === 'files.read') return { ...failure, message: GIT_MESSAGES.filesRead };
    if (permission === 'project.read') return { ...failure, message: GIT_MESSAGES.projectRead };
    return failure;
  }
  const known = failure.reason ? (GIT_ERROR_MESSAGES as Record<string, string>)[failure.reason] : undefined;
  return known ? { ...failure, message: known } : failure;
}

/** Whether a failure means "start the list again" (the checkout changed, or the cursor is gone). */
export function restartsDiff(error: unknown) {
  const failure = describeGitError(error);
  return (failure.code === 1004 && failure.reason === 'stale_snapshot') || (failure.code === -32602 && failure.reason === 'invalid_cursor');
}

/**
 * The registry workspace of the open workspace path: the rows whose directory is the path, or
 * its canonical path as the grant names it, not archived; pinned first, then oldest (as the
 * sidebar lists them). Undefined when the host has none.
 */
export function registryWorkspaceOf(state: { principal: import('./gateway.js').Principal | null; workspace: string | null; registry: { workspaces: import('@anhlp/alp-protocol').RegistryWorkspace[]; }; }) {
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
 */
export function gitAccess(state: { connection: { capabilities: string[]; }; principal: import('./gateway.js').Principal | null; workspace: string | null; registry: { workspaces: import('@anhlp/alp-protocol').RegistryWorkspace[]; loading?: boolean; }; }): { status: true; workspaceId: string; content: boolean; contentMessage?: string; } | { status: false; reason: 'workspace' | 'capability' | 'projectRead' | 'registry' | 'loading' | 'unregistered'; message: string; } {
  const refuse = (reason: 'workspace' | 'capability' | 'projectRead' | 'registry' | 'loading' | 'unregistered') => ({ status: false as const, reason, message: GIT_MESSAGES[reason] });
  if (!state.workspace) return refuse('workspace');
  if (!state.connection.capabilities.includes('workspace.git')) return refuse('capability');
  if (!can(state.principal ?? undefined, 'project.read')) return refuse('projectRead');
  if (!state.connection.capabilities.includes('workspace.registry')) return refuse('registry');
  const row = registryWorkspaceOf(state);
  if (!row) return refuse(state.registry.loading ? 'loading' : 'unregistered');
  const content = can(state.principal ?? undefined, 'files.read');
  return { status: true, workspaceId: row.id, content, ...(content ? {} : { contentMessage: GIT_MESSAGES.filesRead }) };
}

/** A path for workspace.git.diff's `path`: relative and not blocked, else undefined. */
export function gitRequestPath(path: unknown) {
  const relative = typeof path === 'string' && path ? relativeFilePath(path) : undefined;
  return relative && !blockedFilePath(relative) ? relative : undefined;
}

/**
 * The comparison to ask for: the mode, a base branch only for `base` (none: the status's
 * default), ignoreWhitespace only when set.
 */
export function gitCompare({ mode, baseRef, ignoreWhitespace }: { mode: string; baseRef?: string | null; ignoreWhitespace?: boolean; }): import('@anhlp/alp-protocol').GitCompare {
  const known = GIT_MODES.some(entry => entry.id === mode) ? (mode as import('@anhlp/alp-protocol').GitCompare['mode']) : 'uncommitted';
  return { mode: known, ...(known === 'base' && baseRef ? { baseRef } : {}), ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}) };
}

/**
 * The diff as loaded so far: pages appended in order, hidden counts summed; the last page's
 * cursor continues it. A page of another snapshot starts it again.
 */
export type DiffView = { compare: import('@anhlp/alp-protocol').GitDiffPage['compare']; snapshot: string; files: import('@anhlp/alp-protocol').GitDiffFile[]; hiddenCount: number; truncated: boolean; nextCursor?: string; };
export function appendDiffPage(current: DiffView | undefined, page: import('@anhlp/alp-protocol').GitDiffPage): DiffView {
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
 */
export function diffRows(file: import('@anhlp/alp-protocol').GitDiffFile): Array<{ type: 'hunk'; text: string; } | { type: 'add' | 'remove' | 'context'; text: string; oldLine?: number; newLine?: number; noNewline?: boolean; }> {
  const rows: ReturnType<typeof diffRows> = [];
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

/**
 * Paseo's split (side-by-side) diff: the unified rows of diffRows paired into old | new cells. A
 * hunk header spans both sides; a context row shows on both; a run of removals followed by a run
 * of additions is paired line by line (the shorter side padded with empty cells), as GitHub and
 * Paseo's split view do. Nothing is re-diffed: the pairing only follows the hunk's own order.
 */
export function splitRows(rows: ReturnType<typeof diffRows>): Array<{ type: 'hunk'; text: string; } | { type: 'pair'; old?: { type: 'remove' | 'context'; text: string; line: number; noNewline?: boolean; }; new?: { type: 'add' | 'context'; text: string; line: number; noNewline?: boolean; }; }> {
  const out: ReturnType<typeof splitRows> = [];
  // any: diff rows of either side, collected and paired as they come.
  let removes: any[] = [];
  // any: diff rows of either side, collected and paired as they come.
  let adds: any[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removes.length, adds.length); index++) {
      const removed = removes[index];
      const added = adds[index];
      out.push({
        type: 'pair',
        ...(removed ? { old: { type: 'remove', text: removed.text, line: removed.oldLine, ...(removed.noNewline ? { noNewline: true } : {}) } } : {}),
        ...(added ? { new: { type: 'add', text: added.text, line: added.newLine, ...(added.noNewline ? { noNewline: true } : {}) } } : {}),
      });
    }
    removes = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.type === 'remove') {
      // A removal after additions starts a new block: the additions before it pair with earlier removals only.
      if (adds.length) flush();
      removes.push(row);
    } else if (row.type === 'add') adds.push(row);
    else {
      flush();
      if (row.type === 'hunk') out.push({ type: 'hunk', text: row.text });
      else out.push({ type: 'pair', old: { type: 'context', text: row.text, line: row.oldLine as number, ...(row.noNewline ? { noNewline: true } : {}) }, new: { type: 'context', text: row.text, line: row.newLine as number, ...(row.noNewline ? { noNewline: true } : {}) } });
    }
  }
  flush();
  return out;
}

/** The most review comments kept for one workspace, and the longest one (characters). */
export const REVIEW_LIMITS = Object.freeze({ maxComments: 50, maxCommentLength: 4000, maxExcerptLength: 300 });

/**
 * The message a diff review sends to the session's agent (Paseo's "Send review to agent"): each
 * comment under its file and line, the line it is about quoted, in file then line order. Plain
 * text only: nothing here is run or linked; the agent reads it as the user's message.
 *
 * @param label the comparison, such as "Uncommitted"
 */
export function formatReviewComments(comments: Array<{ path: string; side: 'old' | 'new'; line: number; excerpt: string; text: string; }>, label?: string) {
  const sorted = [...comments].sort((a, b) => a.path === b.path ? a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) : a.path < b.path ? -1 : 1);
  const lines = [`Review comments on the diff${label ? ` (${label})` : ''}. Please address each one:`];
  let file = '';
  for (const comment of sorted) {
    if (comment.path !== file) { file = comment.path; lines.push('', `## ${file}`); }
    const excerpt = comment.excerpt.length > REVIEW_LIMITS.maxExcerptLength ? `${comment.excerpt.slice(0, REVIEW_LIMITS.maxExcerptLength)}…` : comment.excerpt;
    lines.push('', `Line ${comment.line}${comment.side === 'old' ? ' (removed line, old numbering)' : ''}:`, `> ${excerpt}`, comment.text.trim());
  }
  return lines.join('\n');
}

/** Additions and deletions of a list of diff files. */
export function diffTotals(files: Array<{ additions: number; deletions: number; }>) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) { additions += file.additions || 0; deletions += file.deletions || 0; }
  return { additions, deletions };
}

/** A count as Paseo's formatDiffCount: 1.2k past a thousand. */
export function formatDiffCount(value: number) {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.floor(value || 0)));
  const thousands = value / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}

/**
 * The branch header's text: the branch (or "Detached at <short head>"), its upstream and how far
 * it is ahead/behind, the base it compares to.
 */
export function branchLine(status: import('@anhlp/alp-protocol').GitStatus) {
  const name = status.branch ?? (status.detached && status.head ? `Detached at ${status.head.slice(0, 7)}` : status.head ? status.head.slice(0, 7) : 'No commits yet');
  const parts = [name];
  if (status.upstream) {
    const { ref, ahead, behind } = status.upstream;
    parts.push(`${ref}${ahead || behind ? ` (${[ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ')})` : ''}`);
  }
  return parts.join(' · ');
}

/** The base a Committed diff compares to, as Paseo's computeBaseRefLabel (origin/ left out too). */
export function baseLabel(baseRef: string | null | undefined) {
  if (!baseRef) return 'base';
  const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, '').trim();
  return trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
}

/**
 * Paseo's file-change icon kind (FileChangeIcon via diffFileChangeKind): new (added, untracked),
 * deleted, or modified (every other change, renames included).
 */
export function changeKind(change: string): 'added' | 'deleted' | 'modified' {
  if (change === 'added' || change === 'untracked') return 'added';
  if (change === 'deleted') return 'deleted';
  return 'modified';
}

/**
 * Paseo's changed-files tree (git/diff-tree.ts at v0.17.3): directories before files, plain
 * code-unit order (not the locale's); a chain of single-child directories is one row
 * ("packages/app/src") keyed by its deepest directory's full path, so a collapsed folder stays
 * collapsed when the chain later splits. Each folder row carries its whole subtree's +/-,
 * collapsed or not; the rows of a collapsed folder's descendants are left out.
 */
export function changesTree<F extends { path: string, additions?: number, deletions?: number }>(files: F[], collapsed: ReadonlySet<string> | string[] = []): Array<{ kind: 'folder'; dirPath: string; name: string; depth: number; additions: number; deletions: number; } | { kind: 'file'; file: F; name: string; depth: number; }> {
  const closed = collapsed instanceof Set ? collapsed : new Set(collapsed);
  type Dir = { kind: 'dir'; dirPath: string; name: string; children: Node[]; };
  type Node = Dir | { kind: 'file'; file: F; name: string; };
  const root: Dir = { kind: 'dir', dirPath: '', name: '', children: [] };
  const dirs: Map<string, Dir> = new Map([['', root]]);
  const ensure = (dirPath: string): Dir => {
    const known = dirs.get(dirPath);
    if (known) return known;
    const parts = dirPath.split('/');
    const node: Dir = { kind: 'dir', dirPath, name: parts[parts.length - 1], children: [] };
    ensure(parts.slice(0, -1).join('/')).children.push(node);
    dirs.set(dirPath, node);
    return node;
  };
  for (const file of files) {
    const parts = file.path.split('/');
    ensure(parts.slice(0, -1).join('/')).children.push({ kind: 'file', file, name: parts[parts.length - 1] });
  }
  const sort = (node: Dir) => {
    node.children.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name === b.name ? 0 : a.name < b.name ? -1 : 1);
    for (const child of node.children) if (child.kind === 'dir') sort(child);
  };
  sort(root);
  const compress = (node: Dir): Dir => {
    let { name, dirPath } = node;
    let children = node.children.map(child => child.kind === 'dir' ? compress(child) : child);
    while (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0];
      name = name ? `${name}/${only.name}` : only.name;
      dirPath = only.dirPath;
      children = only.children;
    }
    return { kind: 'dir', dirPath, name, children };
  };
  const top = root.children.map(child => child.kind === 'dir' ? compress(child) : child);
  const stats: Map<Dir, { additions: number; deletions: number; }> = new Map();
  const sum = (children: Node[]) => {
    let additions = 0;
    let deletions = 0;
    for (const child of children) {
      if (child.kind === 'file') { additions += child.file.additions || 0; deletions += child.file.deletions || 0; continue; }
      const inner = sum(child.children);
      stats.set(child, inner);
      additions += inner.additions;
      deletions += inner.deletions;
    }
    return { additions, deletions };
  };
  sum(top);
  const rows: ReturnType<typeof changesTree<F>> = [];
  const walk = (children: Node[], depth: number) => {
    for (const child of children) {
      if (child.kind === 'file') { rows.push({ kind: 'file', file: child.file, name: child.name, depth }); continue; }
      const { additions, deletions } = stats.get(child) ?? { additions: 0, deletions: 0 };
      rows.push({ kind: 'folder', dirPath: child.dirPath, name: child.name, depth, additions, deletions });
      if (!closed.has(child.dirPath)) walk(child.children, depth + 1);
    }
  };
  walk(top, 0);
  return rows;
}

/**
 * The Committed item's description in the mode menu, as Paseo's computeCommittedDiffDescription:
 * "branch -> base", nothing when either is unknown or they are the same branch.
 */
export function committedDescription(branch: string | null | undefined, baseRef: string | null | undefined) {
  const base = baseRef ? baseLabel(baseRef) : '';
  return branch && base && branch !== base ? `${branch} -> ${base}` : undefined;
}

/**
 * The empty state's offer, as Paseo's computeChangesEmptyAction: none while whitespace is hidden;
 * Committed with nothing in it but a dirty checkout offers Uncommitted; Uncommitted with nothing
 * in it but commits ahead of the base offers Committed.
 */
export function changesEmptyAction({ mode, ignoreWhitespace, status }: { mode: string; ignoreWhitespace: boolean; status: { dirty?: boolean; aheadBehind?: { ahead: number; } | null; } | null | undefined; }): 'uncommitted' | 'base' | null {
  if (ignoreWhitespace || !status) return null;
  if (mode === 'base' && status.dirty) return 'uncommitted';
  if (mode === 'uncommitted' && (status.aheadBehind?.ahead ?? 0) > 0) return 'base';
  return null;
}

/**
 * Where Hide whitespace is remembered (this browser only), as Paseo keeps `hideWhitespace` in its
 * global changes preferences (hooks/use-changes-preferences/storage.ts, `@paseo:changes-preferences`).
 * ALP keeps each Changes preference under its own key, as `alp.diff.layout` and `alp.changes.inlineDiff`.
 */
export const HIDE_WHITESPACE_KEY = 'alp.changes.hideWhitespace';

/**
 * The remembered Hide whitespace: only the stored text 'true' turns it on; anything else, no
 * storage, or storage that throws (private mode) is the default, off.
 */
export function loadHideWhitespace(storage: { getItem(key: string): string | null; } | null | undefined) {
  try { return storage?.getItem(HIDE_WHITESPACE_KEY) === 'true'; } catch { return false; }
}

/** Remembers Hide whitespace; storage that throws keeps it for this page only. */
export function saveHideWhitespace(storage: { setItem(key: string, value: string): void; } | null | undefined, hide: boolean) {
  try { storage?.setItem(HIDE_WHITESPACE_KEY, hide ? 'true' : 'false'); } catch { /* private mode: this page only */ }
}
