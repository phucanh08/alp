// @ts-check
/**
 * Tool calls in the stream, the pure half of Paseo's tool-call views (b63a325:
 * packages/protocol/src/tool-call-display.ts, packages/app/src/utils/tool-call-icon-name.ts,
 * tool-call-parsers.ts): the collapsed row's label, secondary text and icon per detail type,
 * paths made relative to the workspace, unified diffs parsed with line numbers, a bounded line
 * diff of two strings, and line clipping for long bodies. No React.
 *
 * ALP's own tools (alp_*) keep their earlier rows: "Delegate to <agent>", else the name without
 * the prefix and the first string argument. A detail type this build does not know renders as
 * `unknown` (the protocol lets newer hosts add types).
 */

/** The detail types this build renders with their own view. */
export const DETAIL_TYPES = Object.freeze(['shell', 'read', 'edit', 'write', 'search', 'fetch', 'sub_agent', 'plan', 'plain_text', 'unknown']);

/** Lines a detail body shows before its "Show more" control, and how many each click adds. */
export const LINE_LIMIT = 400;

/** Above this many old×new lines (after the common head and tail), a string edit is shown as a block of removals then additions. */
export const DIFF_CELL_LIMIT = 1_000_000;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const text = value => typeof value === 'string' ? value : '';
/** @param {string} value */
const firstLine = value => value.split('\n').find(line => line.trim())?.trim() ?? '';

/**
 * The detail's type when this build knows it, else 'unknown'.
 * @param {unknown} detail
 */
export function detailKind(detail) {
  const type = isRecord(detail) ? detail.type : undefined;
  return typeof type === 'string' && DETAIL_TYPES.includes(type) ? type : 'unknown';
}

/**
 * A path relative to the first root it lies in (Paseo's stripCwdPrefix), "." for a root itself;
 * other paths as given.
 * @param {string} filePath
 * @param {ReadonlyArray<string | undefined | null>} [roots]
 */
export function relativePath(filePath, roots = []) {
  if (!filePath) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  for (const root of roots) {
    if (!root) continue;
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!base) continue;
    if (normalized === base) return '.';
    if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  }
  return filePath;
}

/**
 * Paseo's humanizeToolName: `web_search` → "Web search"; names with `:`, `.`, `/` or `__` (MCP
 * tools such as `mcp__server__tool`) stay as they are.
 * @param {string} name
 */
export function humanizeToolName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return 'Tool';
  if (/[:./]/.test(trimmed) || trimmed.includes('__')) return trimmed;
  return trimmed.replace(/[._-]+/g, ' ').split(' ').filter(Boolean).join(' ').toLowerCase().replace(/^./, c => c.toUpperCase());
}

/**
 * The short "what" of a call without a typed detail: its first string argument, first line.
 * @param {unknown} input
 */
export function firstArgument(input) {
  if (typeof input === 'string') return firstLine(input);
  if (isRecord(input)) {
    const value = Object.values(input).find(field => typeof field === 'string' && field.trim());
    if (typeof value === 'string') return firstLine(value);
  }
  return '';
}

/**
 * @typedef {'terminal' | 'eye' | 'pencil' | 'search' | 'bot' | 'brain' | 'wrench'} ToolIcon
 * @typedef {{ kind: string, label: string, secondary: string, icon: ToolIcon }} ToolPresentation
 */

/** Paseo's TOOL_DETAIL_ICON_NAMES. @type {Record<string, ToolIcon>} */
const ICONS = { shell: 'terminal', read: 'eye', edit: 'pencil', write: 'pencil', search: 'search', fetch: 'search', sub_agent: 'bot', plan: 'brain', plain_text: 'wrench', unknown: 'wrench' };

/**
 * The collapsed row of a tool call: its label, secondary text and icon (Paseo's
 * buildToolCallDisplayModel and resolveToolCallIconName).
 * @param {{ name?: unknown, detail?: unknown }} item
 * @param {ReadonlyArray<string | undefined | null>} [roots] where file paths are shown relative to
 * @returns {ToolPresentation}
 */
export function presentToolCall(item, roots = []) {
  const name = typeof item?.name === 'string' ? item.name : '';
  const kind = detailKind(item?.detail);
  const detail = /** @type {Record<string, any>} */ (isRecord(item?.detail) ? item.detail : {});
  const lower = name.trim().toLowerCase();
  const icon = lower === 'task' || name === 'alp_delegate' ? 'bot' : ICONS[kind];
  switch (kind) {
    case 'shell': return { kind, label: 'Shell', secondary: firstLine(text(detail.command)), icon };
    case 'read': return { kind, label: 'Read', secondary: relativePath(text(detail.filePath), roots), icon };
    case 'edit': return { kind, label: 'Edit', secondary: relativePath(text(detail.filePath), roots), icon };
    case 'write': return { kind, label: 'Write', secondary: relativePath(text(detail.filePath), roots), icon };
    case 'search': return { kind, label: 'Search', secondary: firstLine(text(detail.query)), icon };
    case 'fetch': return { kind, label: 'Fetch', secondary: text(detail.url), icon };
    case 'sub_agent': return { kind, label: text(detail.subAgentType).trim() || 'Task', secondary: firstLine(text(detail.description)), icon };
    case 'plan': return { kind, label: 'Plan', secondary: '', icon };
    case 'plain_text': return { kind, label: humanizeToolName(name), secondary: firstLine(text(detail.label)), icon };
    default: {
      if (name === 'alp_delegate') return { kind, label: 'Delegate', secondary: `to ${detail.input?.agent ?? 'an agent'}`, icon };
      const label = name.startsWith('alp_') ? name.replace(/^alp_/, '').replace(/^\w/, c => c.toUpperCase()) : humanizeToolName(name);
      return { kind, label, secondary: firstArgument(detail.input), icon };
    }
  }
}

/**
 * A text's lines: `\r\n` as `\n`, no empty last line for a final newline.
 * @param {string | undefined | null} value
 */
export function splitLines(value) {
  if (!value) return [];
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The first lines of a list and how many more there are.
 * @template T
 * @param {T[]} lines
 * @param {number} [limit]
 * @returns {{ shown: T[], hidden: number }}
 */
export function clipLines(lines, limit = LINE_LIMIT) {
  const max = Math.max(0, Math.floor(limit));
  return lines.length > max ? { shown: lines.slice(0, max), hidden: lines.length - max } : { shown: lines, hidden: 0 };
}

/**
 * @typedef {{ type: 'add' | 'remove' | 'context' | 'hunk' | 'file' | 'meta', text: string, oldLine?: number, newLine?: number }} DiffLine
 */

/**
 * A unified diff as lines with their old and new line numbers. File headers (`--- a/x`,
 * `+++ b/x`, `diff --git`, `index`) are dropped, but a diff of several files gets a `file` line
 * before each one. Inside a hunk, its counts decide what a line is, so a removed `-- x` line is
 * not mistaken for a header. Lines before any hunk are read by their first character.
 * @param {string | undefined | null} diff
 * @returns {DiffLine[]}
 */
export function parseUnifiedDiff(diff) {
  const lines = splitLines(diff);
  /** @type {DiffLine[]} */
  const out = [];
  /** @type {string[]} */
  const files = [];
  /** @type {number[]} where each file's header would go */
  const fileAt = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let pendingFile = '';
  for (const line of lines) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk) {
      if (line.startsWith('+')) { out.push({ type: 'add', text: line.slice(1), newLine: newLine++ }); newLeft--; continue; }
      if (line.startsWith('-')) { out.push({ type: 'remove', text: line.slice(1), oldLine: oldLine++ }); oldLeft--; continue; }
      if (line.startsWith('\\')) { out.push({ type: 'meta', text: line }); continue; }
      if (line.startsWith(' ') || line === '') { out.push({ type: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); oldLeft--; newLeft--; continue; }
      // Anything else ends the hunk early (a malformed count): read it as a header line below.
      oldLeft = 0; newLeft = 0;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      if (pendingFile) { files.push(pendingFile); fileAt.push(out.length); pendingFile = ''; }
      out.push({ type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('diff --git ')) { pendingFile = line.replace(/^diff --git a\/(.*?) b\/.*$/, '$1'); continue; }
    if (line.startsWith('+++ ')) { const target = line.slice(4).replace(/^b\//, '').replace(/\t.*$/, ''); if (target !== '/dev/null') pendingFile = target; continue; }
    if (line.startsWith('--- ')) { const source = line.slice(4).replace(/^a\//, '').replace(/\t.*$/, ''); if (source !== '/dev/null' && !pendingFile) pendingFile = source; continue; }
    if (line.startsWith('index ') || /^(new|deleted) file mode /.test(line) || /^(similarity|rename|old mode|new mode)/.test(line)) continue;
    if (line.startsWith('@@')) { out.push({ type: 'hunk', text: line }); continue; }
    // No hunk header: Paseo's reading by the first character, without numbers.
    if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) out.push({ type: 'remove', text: line.slice(1) });
    else if (line.startsWith('\\')) out.push({ type: 'meta', text: line });
    else out.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  if (files.length > 1) for (let i = files.length - 1; i >= 0; i--) out.splice(fileAt[i], 0, { type: 'file', text: files[i] });
  return out;
}

/**
 * The line diff of two strings (an edit's oldString and newString), Paseo's buildLineDiff made
 * bounded: the common head and tail are matched first, and when what is left exceeds `cellLimit`
 * old×new lines it is shown as its removals then its additions instead of a longest common
 * subsequence. Line numbers count from 1 in each string: the strings are fragments of a file
 * whose position the detail does not say, so callers may choose not to show them.
 * @param {string | undefined | null} before
 * @param {string | undefined | null} after
 * @param {{ cellLimit?: number }} [options]
 * @returns {{ lines: DiffLine[], exact: boolean }}
 */
export function lineDiff(before, after, { cellLimit = DIFF_CELL_LIMIT } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  /** @type {DiffLine[]} */
  const lines = [];
  for (let i = 0; i < head; i++) lines.push({ type: 'context', text: a[i], oldLine: i + 1, newLine: i + 1 });
  const m = a.length - head - tail;
  const n = b.length - head - tail;
  let exact = true;
  if (m && n && m * n <= cellLimit) {
    // dp[i][j]: the longest common subsequence of a[head+i..] and b[head+j..], in one flat array.
    const width = n + 1;
    const dp = new Uint32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * width + j] = a[head + i] === b[head + j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[head + i] === b[head + j]) { lines.push({ type: 'context', text: a[head + i], oldLine: head + i + 1, newLine: head + j + 1 }); i++; j++; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { lines.push({ type: 'remove', text: a[head + i], oldLine: head + i + 1 }); i++; }
      else { lines.push({ type: 'add', text: b[head + j], newLine: head + j + 1 }); j++; }
    }
    for (; i < m; i++) lines.push({ type: 'remove', text: a[head + i], oldLine: head + i + 1 });
    for (; j < n; j++) lines.push({ type: 'add', text: b[head + j], newLine: head + j + 1 });
  } else {
    exact = !(m && n);
    for (let i = 0; i < m; i++) lines.push({ type: 'remove', text: a[head + i], oldLine: head + i + 1 });
    for (let j = 0; j < n; j++) lines.push({ type: 'add', text: b[head + j], newLine: head + j + 1 });
  }
  for (let k = tail; k > 0; k--) lines.push({ type: 'context', text: a[a.length - k], oldLine: a.length - k + 1, newLine: b.length - k + 1 });
  return { lines, exact };
}

/**
 * An edit detail's diff lines: its unified diff when it has one, else the line diff of its old
 * and new strings. `numbered` says whether the line numbers are the file's.
 * @param {{ unifiedDiff?: unknown, oldString?: unknown, newString?: unknown }} detail
 * @param {{ cellLimit?: number }} [options]
 * @returns {{ lines: DiffLine[], numbered: boolean, exact: boolean }}
 */
export function editDiff(detail, options) {
  const unified = text(detail?.unifiedDiff);
  if (unified) {
    const lines = parseUnifiedDiff(unified);
    return { lines, numbered: lines.some(line => line.type === 'hunk' && /^@@ -\d/.test(line.text)), exact: true };
  }
  const { lines, exact } = lineDiff(text(detail?.oldString), text(detail?.newString), options);
  return { lines, numbered: false, exact };
}

/**
 * How many lines a diff adds and removes.
 * @param {DiffLine[]} lines
 */
export function diffStats(lines) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'remove') removed++;
  }
  return { added, removed };
}

/**
 * A URL safe to link to: http or https only, else undefined.
 * @param {unknown} url
 */
export function safeLink(url) {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A value as text for the input/output view: strings as they are, the rest as indented JSON.
 * @param {unknown} value
 */
export function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
