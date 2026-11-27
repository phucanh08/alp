import { WORKSPACE_GIT } from '@anhlp/alp-protocol';
import type { GitChange, GitCompare, GitDiffFile, GitDiffHunk } from '@anhlp/alp-protocol';
import { PRIVATE_KEY } from './files.ts';
import { GIT_READ, failed } from './git-process.ts';

export type CursorBody = { offset: number; snapshot: string };

export function cursorScope(workspaceId: string, compare: GitCompare, relative: string | undefined, body: CursorBody) {
  return JSON.stringify([workspaceId, compare.mode, compare.baseRef ?? null, compare.ignoreWhitespace === true, relative ?? null, body.snapshot, body.offset]);
}

// ---- Parsing Git's answers ----

/** An all-zero mode (no such side) or object id (the work tree, not hashed). */
export const ZERO = /^0+$/;
export const GITLINK = '160000';
export const SYMLINK = '120000';

export type Entry = {
  path: string; oldPath?: string; change: GitChange;
  srcMode: string; dstMode: string; srcOid: string; dstOid: string;
  untracked?: true; conflicted?: true;
};

const RAW_CHANGE: Record<string, GitChange> = { A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed', T: 'typechange', U: 'conflicted' };

/** `git diff --raw -z` records: `:<srcmode> <dstmode> <srcoid> <dstoid> <status>\0<path>\0[<path>\0]`. */
export function parseRaw(output: Buffer): Entry[] {
  const fields = output.toString('utf8').split('\0');
  const entries: Entry[] = [];
  const conflicted = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const meta = fields[index++];
    if (!meta) continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRTUX])(\d*)$/.exec(meta);
    if (!match) failed('unexpected change list');
    const [, srcMode, dstMode, srcOid, dstOid, letter] = match!;
    const first = fields[index++];
    const second = letter === 'R' || letter === 'C' ? fields[index++] : undefined;
    if (!first || (second !== undefined && !second)) failed('unexpected change list');
    if (letter === 'X') continue;
    const entry: Entry = second !== undefined
      ? { path: second, oldPath: first!, change: RAW_CHANGE[letter!]!, srcMode: srcMode!, dstMode: dstMode!, srcOid: srcOid!, dstOid: dstOid! }
      : { path: first!, change: RAW_CHANGE[letter!]!, srcMode: srcMode!, dstMode: dstMode!, srcOid: srcOid!, dstOid: dstOid! };
    if (letter === 'U') { conflicted.add(entry.path); entry.conflicted = true; }
    entries.push(entry);
  }
  // Index against work tree in a conflict: Git lists the path unmerged and again against stage 2
  // ("ours"); one entry, conflicted, compared as stage 2 against the work tree.
  const merged: Entry[] = [];
  for (const entry of entries) {
    if (!conflicted.has(entry.path)) { merged.push(entry); continue; }
    if (entry.conflicted) {
      const ours = entries.find(other => other.path === entry.path && !other.conflicted);
      merged.push(ours ? { ...ours, change: 'conflicted', conflicted: true } : entry);
    }
  }
  return merged;
}

/** Git's C-style quoting of a header path (quote.c, core.quotePath=false). */
function quoted(name: string): string {
  if (!/[\x00-\x1f"\\\x7f]/.test(name)) return name;
  let out = '"';
  for (const byte of Buffer.from(name, 'utf8')) {
    const letter = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' }[byte];
    if (letter) out += `\\${letter}`;
    else if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte < 0x20 || byte === 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  // Bytes over 0x7f were added one by one: put the UTF-8 back together.
  return Buffer.from(`${out}"`, 'latin1').toString('utf8');
}
export const headerOf = (entry: Entry) => `diff --git ${quoted(`a/${entry.oldPath ?? entry.path}`)} ${quoted(`b/${entry.path}`)}`;

type Section = { header: string; bytes: number; chunks: Buffer[] };

/**
 * A patch stream cut into its files' sections, each begun by a `diff --git ` line (no content
 * line can start so: they start with ' ', '+', '-' or '\'). A section keeps at most
 * `keepBytes` (then only its size is counted); the stream at most GIT_READ.maxPatchStreamBytes.
 */
export function sectionsOf(keepBytes: number) {
  const sections: Section[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let atLineStart = true;
  let inHeader = false;
  let total = 0;
  const MARK = Buffer.from('diff --git ');
  // A conflicted path compared as stage 2 is announced so, outside any section.
  const UNMERGED = Buffer.from('* Unmerged path ');
  let skipping = false;
  const append = (bytes: Buffer) => {
    const current = sections.at(-1);
    if (!current) failed('patch output before a header');
    current!.bytes += bytes.length;
    if (current!.bytes <= keepBytes + 1) current!.chunks.push(Buffer.from(bytes));
  };
  function consume(ended: boolean) {
    let at = 0;
    for (;;) {
      if (inHeader) {
        const newline = buffer.indexOf(10, at);
        if (newline < 0) { if (buffer.length - at > 64 * 1024) failed('patch header over its bound'); break; }
        const line = buffer.subarray(at, newline);
        sections.push({ header: line.toString('utf8'), bytes: line.length + 1, chunks: [] });
        at = newline + 1;
        inHeader = false;
        atLineStart = true;
        continue;
      }
      if (at >= buffer.length) break;
      if (skipping) {
        const newline = buffer.indexOf(10, at);
        if (newline < 0) { if (buffer.length - at > 64 * 1024) failed('patch marker over its bound'); break; }
        at = newline + 1;
        skipping = false;
        atLineStart = true;
        continue;
      }
      if (atLineStart) {
        if (buffer.length - at < UNMERGED.length && !ended) break;
        if (buffer.subarray(at, at + MARK.length).equals(MARK)) { inHeader = true; continue; }
        if (buffer.subarray(at, at + UNMERGED.length).equals(UNMERGED)) { skipping = true; continue; }
        atLineStart = false;
      }
      const newline = buffer.indexOf(10, at);
      if (newline < 0) { append(buffer.subarray(at)); at = buffer.length; break; }
      append(buffer.subarray(at, newline + 1));
      at = newline + 1;
      atLineStart = true;
    }
    buffer = buffer.subarray(at);
    if (ended && (buffer.length || inHeader || skipping)) failed('unterminated patch');
  }
  return {
    sections,
    write(chunk: Buffer) {
      total += chunk.length;
      if (total > GIT_READ.maxPatchStreamBytes) failed('patch output over its bound');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      consume(false);
    },
    end() { consume(true); },
  };
}

export const DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** One file's section as the contract's structure: binary per Git, or its hunks. */
export function parseSection(section: Section): { binary: boolean; hunks: GitDiffHunk[]; additions: number; deletions: number } {
  const lines = DECODER.decode(Buffer.concat(section.chunks)).split('\n');
  const hunks: GitDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let hunk: GitDiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    if (!hunk && (line === 'GIT binary patch' || (line.startsWith('Binary files ') && line.endsWith(' differ')))) return { binary: true, hunks: [], additions: 0, deletions: 0 };
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && oldLeft <= 0 && newLeft <= 0) {
      const context = line.slice(header[0].length).replace(/^ /, '');
      hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), ...(context ? { context } : {}), lines: [] };
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) { const last = hunk.lines.at(-1); if (last) last.noNewline = true; continue; }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', content: line.slice(1) }); additions++; newLeft--; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'remove', content: line.slice(1) }); deletions++; oldLeft--; }
    else if (line.startsWith(' ') || line === '') { hunk.lines.push({ type: 'context', content: line.slice(1) }); oldLeft--; newLeft--; }
  }
  return { binary: false, hunks, additions, deletions };
}

/** An untracked file's content as one hunk of added lines. */
export function addedHunks(text: string): { hunks: GitDiffHunk[]; additions: number } {
  if (!text) return { hunks: [], additions: 0 };
  const endsWithNewline = text.endsWith('\n');
  const parts = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const lines = parts.map(content => ({ type: 'add' as const, content }));
  if (!endsWithNewline) (lines.at(-1) as { noNewline?: true }).noNewline = true;
  return { hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines }], additions: lines.length };
}

export const holdsKey = (bytes: Buffer) => PRIVATE_KEY.test(bytes.toString('latin1'));

/**
 * A file as it is answered, and what it costs a page: its JSON size. The limits hold for what is
 * sent, not for Git's bytes: decoding replaces each invalid UTF-8 byte with U+FFFD (three bytes),
 * and every line adds its JSON structure. Text whose decoded content is over
 * WORKSPACE_GIT.maxFileBytes, or whose answer alone would be over maxTotalBytes, is too_large.
 */
export function sized(file: GitDiffFile): { file: GitDiffFile; cost: number } {
  const cost = (value: GitDiffFile) => Buffer.byteLength(JSON.stringify(value)) + 1;
  if (file.kind !== 'text') return { file, cost: cost(file) };
  let content = 0;
  for (const hunk of file.hunks) for (const line of hunk.lines) content += Buffer.byteLength(line.content, 'utf8');
  const bytes = cost(file);
  if (content <= WORKSPACE_GIT.maxFileBytes && bytes <= PAGE_BYTES) return { file, cost: bytes };
  const large: GitDiffFile = { ...file, kind: 'too_large', additions: 0, deletions: 0, hunks: [] };
  return { file: large, cost: cost(large) };
}

/** What one page's files may take as JSON: WORKSPACE_GIT.maxTotalBytes, less room for the rest of the answer. */
export const PAGE_BYTES = WORKSPACE_GIT.maxTotalBytes - 16 * 1024;

