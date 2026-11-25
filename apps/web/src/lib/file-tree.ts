import { WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';

/**
 * The Files panel's tree, as Paseo's file explorer (file-explorer/tree.ts at b63a325, unchanged in
 * v0.17.3): one listing per directory, read when it is expanded (workspace.files.list), shown as
 * rows of a flat list, directories first, sorted by name, modified time or size (the sort button
 * cycles), dot-names hidden unless asked. An open folder whose listing is on its way shows a
 * spinner in its chevron's place and nothing under it yet; an empty one shows nothing under it
 * (Paseo's flattenExplorerTree). Pure, no React.
 *
 * Paths are workspace-relative, '/'-separated, as the host gives them (docs/protocol §12.4).
 */

export type FileEntry = { name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string; };

export type Listing = { status: 'loading' | 'ready' | 'error'; entries?: FileEntry[]; truncated?: boolean; error?: string; };

export type SortOption = 'name' | 'modified' | 'size';

export type TreeRow = { kind: 'entry'; entry: FileEntry; depth: number; open: boolean; loading?: boolean; } |
{ kind: 'status'; path: string; depth: number; status: 'loading' | 'error' | 'empty' | 'truncated'; message?: string; };

/** Paseo's SORT_OPTIONS, in the order its sort button goes through them. */
export const SORT_OPTIONS = ['name', 'modified', 'size'] as const;
export const SORT_LABELS = Object.freeze({ name: 'Name', modified: 'Modified', size: 'Size' });

/** The sort after `sort`, as Paseo's sort button cycles. */
export function nextSort(sort: SortOption): SortOption {
  const index = SORT_OPTIONS.indexOf(sort);
  return SORT_OPTIONS[(index + 1) % SORT_OPTIONS.length];
}

/**
 * A workspace-relative path safe to ask for, cleaned ('./' dropped), or undefined: no absolute
 * path, drive, backslash, NUL, '.', '..' or empty segment, within the protocol's length. A blocked
 * path is still returned here: see blockedFilePath.
 */
export function relativeFilePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let path = value;
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.length > WORKSPACE_FILES.maxPathLength) return undefined;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || /[\\\0]/.test(path)) return undefined;
  if (path.split('/').some(segment => !segment || segment === '.' || segment === '..')) return undefined;
  return path;
}

/** Whether a path is one the host never shows (secrets, keys, .git, .alp…). */
export const blockedPath = (path: string) => blockedFilePath(path);

const time = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
};

/**
 * A workspace.files.list answer for directory `directory` ('' the root), kept to what may be
 * shown: entries of that directory only, with a clean relative path, never blocked, at most
 * maxListEntries. Anything else the host sent is dropped.
 */
// any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
export function cleanListing(result: any, directory: string): { entries: FileEntry[]; truncated: boolean; } {
  const prefix = directory ? `${directory}/` : '';
  const entries: FileEntry[] = [];
  const seen = new Set();
  for (const raw of Array.isArray(result?.entries) ? result.entries : []) {
    if (!raw || typeof raw !== 'object') continue;
    const { name, kind } = raw;
    if (typeof name !== 'string' || !name || name.includes('/') || (kind !== 'file' && kind !== 'directory')) continue;
    const path = relativeFilePath(raw.path);
    if (!path || path !== `${prefix}${name}` || blockedFilePath(path) || seen.has(path)) continue;
    seen.add(path);
    entries.push({
      name, path, kind,
      ...(kind === 'file' && typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0 ? { size: raw.size } : {}),
      ...(typeof raw.modifiedAt === 'string' && time(raw.modifiedAt) ? { modifiedAt: raw.modifiedAt } : {}),
    });
    if (entries.length >= WORKSPACE_FILES.maxListEntries) break;
  }
  const dropped = Array.isArray(result?.entries) && result.entries.length > WORKSPACE_FILES.maxListEntries;
  return { entries, truncated: result?.truncated === true || dropped };
}

/** Whether a name is hidden by default (a dot-name, as Paseo's filterVisibleExplorerEntries). */
export const hiddenName = (name: string) => name.startsWith('.');

/** Paseo's sortExplorerEntries: directories first, then by name, newest first or largest first. */
export function sortEntries(entries: FileEntry[], sort: SortOption): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    if (sort === 'modified') return time(b.modifiedAt) - time(a.modifiedAt) || a.name.localeCompare(b.name);
    if (sort === 'size') return (b.size ?? 0) - (a.size ?? 0) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
}

/** `expanded` with `path` opened or closed (Paseo keeps the open paths of closed parents). */
export function toggleExpanded(expanded: string[], path: string): string[] {
  return expanded.includes(path) ? expanded.filter(entry => entry !== path) : [...expanded, path];
}

/**
 * The rows the panel shows: the root's entries, and under each open directory its own (when
 * listed). A status row where the root is loading or empty, or a listing failed or was cut short;
 * an open directory still loading is marked on its own row (`loading`), as Paseo's spinner.
 * @param listings by directory path ('' the root)
 */
export function flattenTree(listings: Record<string, Listing>, expanded: string[], { sort, showHidden }: { sort: SortOption; showHidden: boolean; }): TreeRow[] {
  const open = new Set(expanded);
  const rows: TreeRow[] = [];
  const walk = (directory: string, depth: number) => {
    const listing = listings[directory];
    if (!listing || listing.status === 'loading') { if (!directory) rows.push({ kind: 'status', path: directory, depth, status: 'loading' }); return; }
    if (listing.status === 'error') { rows.push({ kind: 'status', path: directory, depth, status: 'error', ...(listing.error ? { message: listing.error } : {}) }); return; }
    const entries = sortEntries((listing.entries ?? []).filter(entry => showHidden || !hiddenName(entry.name)), sort);
    if (!entries.length && !directory) rows.push({ kind: 'status', path: directory, depth, status: 'empty' });
    for (const entry of entries) {
      const isOpen = entry.kind === 'directory' && open.has(entry.path);
      const pending = isOpen && (!listings[entry.path] || listings[entry.path].status === 'loading');
      rows.push({ kind: 'entry', entry, depth, open: isOpen, ...(pending ? { loading: true } : {}) });
      if (isOpen) walk(entry.path, depth + 1);
    }
    if (listing.truncated) rows.push({ kind: 'status', path: directory, depth, status: 'truncated' });
  };
  walk('', 0);
  return rows;
}

/** A byte count for people: 512 B, 1.4 KB, 2.0 MB. */
export function formatSize(size: number | undefined) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line count of a text: a final newline ends the last line, it does not start one. */
export function lineCount(text: string) {
  if (!text) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Whether a path is a Markdown file (the file view's Preview). */
export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
