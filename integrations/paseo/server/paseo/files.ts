import os from 'node:os';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { WORKSPACE_FILES } from '@anhlp/alp-protocol';
import { nameRank } from '@anhlp/alp-daemon/files';

/**
 * Finding directories and files for the app (D31 step 6, ALPD §62): the folder to add as a
 * project, typed as a path or a name under home, and a workspace's files for `@` mentions, the
 * command center and file links, as Paseo's daemon answers `directory_suggestions`; and the
 * read-only Files panel (step 8).
 *
 * Everything is alpd's answer (docs/protocol/alp-json-rpc-v1.md §12.11): workspace.files.find for
 * every name of a workspace, workspace.files.list for a directory, workspace.files.preview for a
 * file, host.directories.search for the host's folders. The bridge reads no file itself, so alpd's
 * confinement, block list and .gitignore apply, and a refusal or a lost daemon is the answer's
 * error, never a local fallback.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type Rpc = (method: string, params: any) => Promise<any>;
type Entry = { path: string; kind: 'file' | 'directory' };

/** More pages than any bounded alpd answer has: a daemon that keeps answering a cursor is refused. */
const MAX_PAGES = 1_000;
/** The longest query workspace.files.find takes (its schema's maxLength, in code points). */
const FIND_QUERY_LENGTH = 200;

const expand = (query: string) => query === '~' ? os.homedir() : query.startsWith('~/') ? path.join(os.homedir(), query.slice(2)) : query;

/** Every page of a paged alpd answer, in order: `ask` is given each `nextCursor` until none is left. */
async function pages<T extends { nextCursor?: string }>(ask: (cursor?: string) => Promise<T>): Promise<T[]> {
  const answers: T[] = [];
  let cursor: string | undefined;
  do {
    if (answers.length >= MAX_PAGES) throw new Error('The ALP daemon answered more pages than it can have');
    const page = await ask(cursor);
    answers.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return answers;
}

async function workspaceSearch(message: Inbound<'directory_suggestions_request'>, root: string, limit: number, rpc: Rpc): Promise<Entry[]> {
  const kinds = [...(message.includeFiles === true ? ['file' as const] : []), ...(message.includeDirectories !== false ? ['directory' as const] : [])];
  if (!kinds.length) return [];
  const query = message.query.trim().replace(/^\.\//, '');
  if (!query) {
    // The workspace's own entries, as the app shows it before anything is typed.
    const listed = await pages<{ entries: Array<{ name: string; kind: Entry['kind'] }>; nextCursor?: string }>(cursor => rpc('workspace.files.list', { projectRoot: root, includeIgnored: true, internalLinks: true, ...(cursor ? { cursor } : {}) }));
    return listed.flatMap(page => page.entries).filter(entry => !entry.name.startsWith('.') && kinds.includes(entry.kind))
      .map((entry): Entry => ({ path: entry.name, kind: entry.kind }))
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
  }
  // alpd answers every name the ranking below can match, of a whole-tree snapshot, page by page:
  // the ranking is this adapter's own, over a complete set. A query longer than alpd takes is
  // narrowed to its first characters in order, which every match still holds.
  const long = [...query].length > FIND_QUERY_LENGTH;
  const narrowed = long ? [...query].slice(0, FIND_QUERY_LENGTH).join('') : query;
  const found = await pages<{ entries: Entry[]; nextCursor?: string }>(cursor => rpc('workspace.files.find', { projectRoot: root, query: narrowed, kinds, matchMode: message.matchMode === 'suffix' && !long ? 'suffix' : 'subsequence', ...(cursor ? { cursor } : {}) }));
  const all = found.flatMap(page => page.entries).map((entry): Entry => ({ path: entry.path, kind: entry.kind }));
  if (message.matchMode === 'suffix') {
    const wanted = query.toLowerCase();
    return all.filter(entry => entry.path.toLowerCase() === wanted || entry.path.toLowerCase().endsWith(`/${wanted}`)).sort((a, b) => a.path.length - b.path.length).slice(0, limit);
  }
  return all.map(entry => {
    const byName = nameRank(path.posix.basename(entry.path), query);
    const byPath = nameRank(entry.path, query);
    const score = byName ?? (byPath === undefined ? undefined : byPath + 4);
    return { entry, score };
  }).filter((row): row is { entry: Entry; score: number } => row.score !== undefined)
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit).map(row => row.entry);
}

export async function directorySuggestions(message: Inbound<'directory_suggestions_request'>, rpc: Rpc): Promise<Outbound> {
  const limit = message.limit ?? 30;
  try {
    const cwd = message.cwd?.trim();
    const query = message.query.trim();
    const entries: Entry[] = cwd ? await workspaceSearch(message, path.resolve(expand(cwd)), limit, rpc)
      : !query ? []
      // A path typed by the user, or a name under home: the host's folders, as alpd finds them.
      : (await rpc('host.directories.search', { query, limit })).entries.map((entry: { path: string }): Entry => ({ path: entry.path, kind: 'directory' }));
    return { type: 'directory_suggestions_response', payload: { requestId: message.requestId, directories: entries.filter(entry => entry.kind === 'directory').map(entry => entry.path), entries, error: null } };
  } catch (error: any) {
    return { type: 'directory_suggestions_response', payload: { requestId: message.requestId, directories: [], entries: [], error: error?.message ?? String(error) } };
  }
}

/** The app's path as alpd takes it: relative to the workspace, '/'-separated, '' for its root; one that leads out of it is refused here. */
function workspacePath(root: string, requested: string): string {
  const relative = path.relative(root, path.resolve(root, requested || '.'));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Access outside of workspace is not allowed');
  return relative.split(path.sep).join('/');
}

/** alpd's refusal in the words the Files panel showed before, else alpd's own message (it names only the workspace's relative path). */
function explorerError(error: any): string {
  switch (error?.data?.reason) {
    case 'not_found': return 'No such file or directory';
    case 'too_large': return 'File is too large to display';
    case 'outside': case 'invalid_path': return 'Access outside of workspace is not allowed';
  }
  return error?.message ?? String(error);
}

/**
 * The Files panel, read-only (D31 step 8): a directory's entries, links that stay inside included,
 * and a file's content as text, an image, or only its size for anything binary, as alpd answers
 * them; every directory .gitignore'd or not, never a blocked path (.git, .env files, keys). Editing,
 * and new, renamed or deleted files, answer "in development".
 */
export async function fileExplorer(message: Inbound<'file_explorer_request'>, rpc: Rpc): Promise<Outbound> {
  const reply = (fields: Partial<Extract<Outbound, { type: 'file_explorer_response' }>['payload']>): Outbound =>
    ({ type: 'file_explorer_response', payload: { requestId: message.requestId, cwd: message.cwd, path: message.path ?? '.', mode: message.mode, directory: null, file: null, error: null, ...fields } });
  try {
    const root = path.resolve(expand(message.cwd));
    const relative = workspacePath(root, message.path ?? '.');
    const options = { projectRoot: root, includeIgnored: true, internalLinks: true };
    if (message.mode === 'list') {
      const listed = await pages<{ entries: Array<{ name: string; path: string; kind: Entry['kind']; size?: number; modifiedAt?: string }>; nextCursor?: string; target?: string }>(cursor => rpc('workspace.files.list', { ...options, ...(relative ? { path: relative } : {}), ...(cursor ? { cursor } : {}) }));
      // Through a link the directory listed is where it leads, as its entries' paths say.
      const shown = listed[0]?.target ?? (relative || '.');
      const entries = listed.flatMap(page => page.entries).map(entry => ({ name: entry.name, path: entry.path, kind: entry.kind, size: entry.size ?? 0, modifiedAt: entry.modifiedAt ?? '' }));
      entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return reply({ path: shown, directory: { path: shown, entries } });
    }
    if (!relative) throw new Error('. is not a file');
    const maxBytes = Math.min(message.maxBytes ?? WORKSPACE_FILES.maxPreviewBytes, WORKSPACE_FILES.maxPreviewBytes);
    const first = await rpc('workspace.files.preview', { ...options, path: relative, maxBytes });
    const chunks: Buffer[] = first.content === undefined ? [] : [Buffer.from(first.content, 'base64')];
    // The rest in chunks of the same revision: alpd refuses them if the file changed meanwhile.
    for (let offset: number | undefined = first.nextOffset, count = 0; offset !== undefined; count++) {
      if (count >= MAX_PAGES) throw new Error('The ALP daemon answered more chunks than a preview has');
      const chunk = await rpc('workspace.files.preview', { ...options, path: relative, maxBytes, offset, revision: first.revision });
      chunks.push(Buffer.from(chunk.content ?? '', 'base64'));
      offset = chunk.nextOffset;
    }
    const bytes = Buffer.concat(chunks);
    const shown: string = first.target ?? first.path;
    const base = { path: shown, size: first.size, modifiedAt: first.modifiedAt, revision: first.revision };
    if (first.kind === 'image') return reply({ path: shown, file: { ...base, kind: 'image', encoding: 'base64', content: bytes.toString('base64'), mimeType: first.mimeType } });
    if (first.kind === 'binary') return reply({ path: shown, file: { ...base, kind: 'binary', encoding: 'none', mimeType: first.mimeType } });
    return reply({ path: shown, file: { ...base, kind: 'text', encoding: 'utf-8', content: new TextDecoder('utf-8').decode(bytes), mimeType: first.mimeType } });
  } catch (error: any) {
    return reply({ error: explorerError(error) });
  }
}
