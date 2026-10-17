import type { ToolCallDetail } from '@anhlp/alp-protocol/events';

/**
 * Typed tool-call details (ALPD §4.2): what each runtime reports of a tool call, as the
 * provider-neutral shapes of Paseo's ToolCallDetail. Pure functions; a transport attaches the
 * detail to the commandExecution it reports as before, and the runtime emits it.
 *
 * A function returns undefined for a call that stays `shell` as today (Claude's Bash, ACP's
 * execute). A tool ALP cannot type gets `unknown` with its raw input and output.
 */

export type { ToolCallDetail };

/** The bounds of a typed detail (not shell, not unknown), as the protocol states them. */
export const DETAIL_TEXT_CHARS = 65_536;
export const DETAIL_FILE_PATHS = 200;
export const DETAIL_WEB_RESULTS = 50;
export const ERROR_CHARS = 2_000;
export const TOOL_FAILED = 'Tool call failed';

/** The detail types of protocol v1; any other is a later one. */
export const DETAIL_TYPES = ['shell', 'read', 'edit', 'write', 'search', 'fetch', 'sub_agent', 'plan', 'plain_text', 'unknown'] as const;

/** Text kept to `max` characters: its head, then how much was left out. */
export function clipText(text: string, max = DETAIL_TEXT_CHARS): string {
  if (text.length <= max) return text;
  // Already clipped (a detail bounded twice): its marker keeps the count it has.
  const marker = /\n… \(\d+ more characters\)$/.exec(text);
  if (marker && marker.index <= max) return text;
  // Never split a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return `${text.slice(0, end)}\n… (${text.length - end} more characters)`;
}

/** A typed detail within the protocol's bounds; shell and unknown details pass unchanged. */
export function boundDetail(detail: ToolCallDetail): ToolCallDetail {
  if (detail.type === 'shell' || detail.type === 'unknown') return detail;
  const bounded: Record<string, unknown> = {};
  let cut = false;
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    if (typeof value === 'string') bounded[key] = key === 'type' ? value : clipText(value);
    else if (key === 'filePaths' && Array.isArray(value)) {
      bounded[key] = value.slice(0, DETAIL_FILE_PATHS).map(entry => clipText(String(entry)));
      cut = value.length > DETAIL_FILE_PATHS;
    } else if (key === 'webResults' && Array.isArray(value)) {
      bounded[key] = (value as Array<{ title: string; url: string }>).slice(0, DETAIL_WEB_RESULTS).map(entry => ({ title: clipText(entry.title), url: clipText(entry.url) }));
    } else bounded[key] = value;
  }
  // Paths left out make the list a truncated one.
  if (cut) bounded.truncated = true;
  return bounded as ToolCallDetail;
}

/** The error a failed call carries: the tool's own text, clipped, else a fixed one. */
export function toolError(text: unknown): string {
  // Claude wraps a tool's error in <tool_use_error>.
  const value = typeof text === 'string' ? text.trim().replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1').trim() : '';
  return value ? clipText(value, ERROR_CHARS) : TOOL_FAILED;
}

const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const int = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
const pathOf = (input: Record<string, any> | undefined) => str(input?.file_path) ?? str(input?.filePath) ?? str(input?.path) ?? str(input?.notebook_path) ?? str(input?.AbsolutePath) ?? str(input?.TargetFile);
/** Only the fields that are set. */
const defined = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
const typed = (detail: Record<string, unknown>): ToolCallDetail => boundDetail(defined(detail) as ToolCallDetail);

/** The text of a tool result: a string, or the text blocks of a content array. */
export function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean);
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

const READ_GUTTER = /^\s*(\d+)(?:\t|→)(.*)$/;

/**
 * Claude's Read output is `cat -n` style (`   12\tcode` or `   12→code`); this is the raw text
 * and the first line's number, or undefined unless every non-empty line carries the gutter with
 * consecutive numbers. A reminder Claude appends after the content is dropped first.
 */
export function stripReadGutter(text: string): { content: string; startLine: number } | undefined {
  const body = text.replace(/\r\n/g, '\n').replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/g, '');
  const out: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const line of body.split('\n')) {
    if (!line) { out.push(line); continue; }
    const match = READ_GUTTER.exec(line);
    if (!match) return undefined;
    const number = Number.parseInt(match[1], 10);
    if (previous !== undefined && number !== previous + 1) return undefined;
    start ??= number;
    previous = number;
    out.push(match[2]);
  }
  return start === undefined ? undefined : { content: out.join('\n'), startLine: start };
}

/** Hunks of Claude's structuredPatch as a unified diff. */
function structuredPatch(patch: unknown): string | undefined {
  if (!Array.isArray(patch) || !patch.length) return undefined;
  const hunks = patch.map((hunk: any) => {
    const lines = Array.isArray(hunk?.lines) ? hunk.lines.map(String) : [];
    return [`@@ -${hunk?.oldStart ?? 0},${hunk?.oldLines ?? 0} +${hunk?.newStart ?? 0},${hunk?.newLines ?? 0} @@`, ...lines].join('\n');
  });
  return `${hunks.join('\n')}\n`;
}

/** Several string replacements in one file as a diff-like text. */
function replacementsDiff(edits: Array<{ old_string?: unknown; new_string?: unknown }>): string {
  const side = (text: unknown, mark: string) => String(text ?? '').split('\n').map(line => `${mark}${line}`);
  return `${edits.map(edit => ['@@', ...side(edit.old_string, '-'), ...side(edit.new_string, '+')].join('\n')).join('\n')}\n`;
}

const TODO_MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };

/** What Claude's result for a call holds: the tool_result text and the SDK's structured output. */
export type ClaudeResult = { text?: string; structured?: unknown; error?: boolean };

/**
 * The detail of a Claude Code tool call, from its name and input and, once done, its result.
 * Undefined for Bash, which stays a shell command.
 */
export function claudeToolDetail(name: string, rawInput: unknown, result?: ClaudeResult): ToolCallDetail | undefined {
  if (name === 'Bash') return undefined;
  const input = record(rawInput) ?? {};
  const ok = result && !result.error;
  const text = ok ? result.text : undefined;
  const out = ok ? record(result.structured) : undefined;
  const unknown = (): ToolCallDetail => ({ type: 'unknown', input: rawInput ?? null, output: result?.text ?? null });
  const filePath = pathOf(input);

  switch (name) {
    case 'Read': {
      if (!filePath) return unknown();
      const file = out?.type === 'text' ? record(out.file) : undefined;
      const stripped = file ? undefined : text !== undefined ? stripReadGutter(text) : undefined;
      const content = typeof file?.content === 'string' ? file.content : stripped?.content ?? text;
      // The first line's number is where a viewer's own gutter starts; before the result, the input's offset.
      return typed({ type: 'read', filePath, content, offset: int(file?.startLine) ?? stripped?.startLine ?? int(input.offset), limit: int(input.limit) });
    }
    case 'Write':
      if (!filePath) return unknown();
      return typed({ type: 'write', filePath, content: typeof input.content === 'string' ? input.content : undefined });
    case 'Edit':
      if (!filePath) return unknown();
      return typed({ type: 'edit', filePath, oldString: typeof input.old_string === 'string' ? input.old_string : undefined, newString: typeof input.new_string === 'string' ? input.new_string : undefined, unifiedDiff: structuredPatch(out?.structuredPatch) });
    case 'MultiEdit': {
      if (!filePath) return unknown();
      const edits = Array.isArray(input.edits) ? input.edits.filter(record) : [];
      if (edits.length === 1) return typed({ type: 'edit', filePath, oldString: str(edits[0].old_string) ?? undefined, newString: typeof edits[0].new_string === 'string' ? edits[0].new_string : undefined, unifiedDiff: structuredPatch(out?.structuredPatch) });
      return typed({ type: 'edit', filePath, unifiedDiff: structuredPatch(out?.structuredPatch) ?? (edits.length ? replacementsDiff(edits) : undefined) });
    }
    case 'NotebookEdit':
      if (!filePath) return unknown();
      return typed({ type: 'edit', filePath, oldString: typeof out?.old_source === 'string' ? out.old_source : undefined, newString: input.edit_mode === 'delete' ? undefined : typeof input.new_source === 'string' ? input.new_source : undefined });
    case 'Grep': {
      const query = str(input.pattern);
      if (!query) return unknown();
      const structured = out && Array.isArray(out.filenames);
      return typed({
        type: 'search', query, toolName: 'grep',
        content: structured ? (typeof out.content === 'string' ? out.content : undefined) : text,
        filePaths: structured && out.filenames.length ? out.filenames.map(String) : undefined,
        numFiles: structured ? int(out.numFiles) : undefined,
        numMatches: structured ? int(out.numMatches) : undefined,
      });
    }
    case 'Glob': {
      const query = str(input.pattern);
      if (!query) return unknown();
      const structured = out && Array.isArray(out.filenames);
      return typed({
        type: 'search', query, toolName: 'glob',
        content: structured ? undefined : text,
        filePaths: structured && out.filenames.length ? out.filenames.map(String) : undefined,
        numFiles: structured ? int(out.numFiles) : undefined,
        truncated: structured && typeof out.truncated === 'boolean' ? out.truncated : undefined,
      });
    }
    case 'WebFetch': {
      const url = str(input.url) ?? str(out?.url);
      if (!url) return unknown();
      return typed({ type: 'fetch', url, prompt: str(input.prompt), result: typeof out?.result === 'string' ? out.result : text, code: int(out?.code) });
    }
    case 'WebSearch': {
      const query = str(input.query) ?? str(out?.query);
      if (!query) return unknown();
      const entries: unknown[] = Array.isArray(out?.results) ? out.results : [];
      const webResults = entries.flatMap(entry => Array.isArray(record(entry)?.content) ? (entry as any).content : [])
        .filter((hit: any) => typeof hit?.title === 'string' && typeof hit?.url === 'string')
        .map((hit: any) => ({ title: hit.title, url: hit.url }));
      const notes = entries.filter((entry): entry is string => typeof entry === 'string');
      return typed({ type: 'search', query, toolName: 'web_search', webResults: webResults.length ? webResults : undefined, content: out ? (notes.length ? notes.join('\n') : undefined) : text });
    }
    case 'Task':
    case 'Agent': {
      const report = out && Array.isArray(out.content) ? resultText(out.content) : text;
      return typed({ type: 'sub_agent', subAgentType: str(input.subagent_type), description: str(input.description) ?? str(input.prompt), log: report });
    }
    case 'ExitPlanMode':
      return str(input.plan) ? typed({ type: 'plan', text: input.plan }) : unknown();
    case 'Skill':
      return str(input.skill) ? typed({ type: 'plain_text', label: input.skill, text }) : unknown();
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.filter(record) : [];
      if (!todos.length) return unknown();
      return typed({ type: 'plain_text', label: 'Todos', text: todos.map((todo: any) => `${TODO_MARK[todo.status] ?? '[ ]'} ${String(todo.content ?? todo.activeForm ?? '')}`).join('\n') });
    }
    default:
      return unknown();
  }
}

/** What ALP holds of an ACP tool call, merged from its tool_call and tool_call_update notifications. */
export type AcpCall = { kind?: string; title?: string; rawInput?: unknown; rawOutput?: unknown; locations?: unknown; content?: unknown };

/** The text parts of an ACP tool call's content. */
export function acpText(content: unknown): string | undefined {
  const parts = (Array.isArray(content) ? content : [])
    .map((part: any) => part?.type === 'content' && part.content?.type === 'text' ? part.content.text : '')
    .filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

/**
 * The detail of an ACP tool call by its kind (read, edit, delete, move, search, fetch, think,
 * other): its rawInput, rawOutput, locations and content, including diffs. Undefined for execute,
 * which stays a shell command.
 */
export function acpToolDetail(call: AcpCall): ToolCallDetail | undefined {
  const kind = call.kind ?? 'other';
  if (kind === 'execute') return undefined;
  const input = record(call.rawInput);
  const output = record(call.rawOutput);
  const locations = (Array.isArray(call.locations) ? call.locations : []).map(record).filter((entry): entry is Record<string, any> => Boolean(str(entry?.path)));
  const diffs = (Array.isArray(call.content) ? call.content : []).map(record).filter((part): part is Record<string, any> => part?.type === 'diff' && Boolean(str(part.path)));
  const text = acpText(call.content) ?? (typeof call.rawOutput === 'string' ? call.rawOutput : str(output?.output) ?? str(output?.content));
  const title = str(call.title);
  const filePath = locations[0]?.path ?? pathOf(input);
  const unknown = (): ToolCallDetail => ({ type: 'unknown', input: call.rawInput ?? null, output: call.rawOutput ?? text ?? null });

  switch (kind) {
    case 'read':
      if (!filePath) return unknown();
      return typed({ type: 'read', filePath, content: text, offset: int(input?.offset) ?? int(input?.line) ?? int(locations[0]?.line), limit: int(input?.limit) });
    case 'edit':
    case 'delete': {
      const diff = diffs[0];
      if (diff) {
        const oldText = typeof diff.oldText === 'string' ? diff.oldText : undefined;
        const newText = typeof diff.newText === 'string' ? diff.newText : undefined;
        if (oldText === undefined && newText !== undefined && kind === 'edit') return typed({ type: 'write', filePath: diff.path, content: newText });
        return typed({ type: 'edit', filePath: diff.path, oldString: oldText, newString: kind === 'delete' ? undefined : newText });
      }
      if (!filePath) return unknown();
      const oldString = str(input?.old_string) ?? str(input?.oldText) ?? str(input?.old_str);
      const newString = str(input?.new_string) ?? str(input?.newText) ?? str(input?.new_str);
      const unifiedDiff = str(input?.diff) ?? str(input?.patch) ?? str(input?.unified_diff);
      if (kind === 'edit' && !oldString && !unifiedDiff && typeof input?.content === 'string') return typed({ type: 'write', filePath, content: input.content });
      return typed({ type: 'edit', filePath, oldString, newString, unifiedDiff });
    }
    case 'move': {
      const from = filePath ?? str(input?.from) ?? str(input?.source);
      const to = locations[1]?.path ?? str(input?.to) ?? str(input?.destination) ?? str(input?.new_path);
      if (!from) return unknown();
      return typed({ type: 'plain_text', label: title ?? 'Move', text: to ? `${from} → ${to}` : from });
    }
    case 'search': {
      const query = str(input?.query) ?? str(input?.pattern) ?? str(input?.q) ?? title;
      if (!query) return unknown();
      const paths = locations.map(entry => entry.path as string);
      return typed({ type: 'search', query, toolName: 'search', content: text, filePaths: paths.length ? paths : undefined });
    }
    case 'fetch': {
      const url = str(input?.url);
      if (url) return typed({ type: 'fetch', url, prompt: str(input?.prompt), result: text });
      const query = str(input?.query) ?? str(input?.q);
      if (query) return typed({ type: 'search', query, toolName: 'web_search', content: text });
      return unknown();
    }
    case 'think':
      return typed({ type: 'plain_text', label: title ?? 'Thinking', text: text ?? str(input?.thought) ?? str(input?.text) });
    default:
      return unknown();
  }
}

/**
 * The detail of an Antigravity tool step from its tool_info (name, parameters, output, error):
 * run_command is a shell command, view_file a read, write_to_file a write, the replace tools
 * edits; any other is unknown.
 */
export function antigravityToolDetail(info: unknown): ToolCallDetail {
  const tool = record(info);
  const parameters = record(tool?.parameters) ?? {};
  // A running step's output is empty: nothing yet.
  const output = typeof tool?.output === 'string' && tool.output ? tool.output : undefined;
  const filePath = str(parameters.AbsolutePath) ?? str(parameters.TargetFile);
  switch (tool?.name) {
    case 'run_command':
      if (typeof parameters.CommandLine === 'string') return { type: 'shell', command: parameters.CommandLine, ...(str(parameters.Cwd) ? { cwd: parameters.Cwd } : {}), output: output ?? '' };
      break;
    case 'view_file':
      if (filePath) return typed({ type: 'read', filePath, content: output, offset: int(parameters.StartLine), limit: int(parameters.EndLine) !== undefined && int(parameters.StartLine) !== undefined ? parameters.EndLine - parameters.StartLine + 1 : undefined });
      break;
    case 'write_to_file':
      if (filePath) return typed({ type: 'write', filePath, content: typeof parameters.CodeContent === 'string' ? parameters.CodeContent : undefined });
      break;
    case 'replace_file_content':
    case 'multi_replace_file_content':
      if (filePath) return typed({ type: 'edit', filePath, oldString: typeof parameters.TargetContent === 'string' ? parameters.TargetContent : undefined, newString: typeof parameters.ReplacementContent === 'string' ? parameters.ReplacementContent : undefined });
      break;
  }
  return { type: 'unknown', input: tool?.parameters ?? null, output: tool?.error?.message ?? output ?? null };
}

/** A Codex native item ALP shows as a tool call. */
export type CodexToolCall = { name: string; status: 'running' | 'completed' | 'failed'; detail: ToolCallDetail; error?: string };

/** `--- a/<path>` / `+++ b/<path>` headers on a file's diff that lacks them. */
function withHeaders(path: string, diff: string) {
  // Only a diff that starts with its header has one: a removed `-- x` line inside is not it.
  return /^(--- |diff --git )/.test(diff) ? diff : `--- a/${path}\n+++ b/${path}\n${diff}`;
}

/** Text that starts as a unified diff does: a file header or a hunk (a line inside content does not count). */
const looksLikeDiff = (text: string) => /^(@@ |--- |\+\+\+ |diff --git )/.test(text);

/**
 * A change's diff text as a unified diff. Codex reports an added or deleted file's whole content
 * in `diff` (codex-rs app-server: FileChange::Add/Delete carry `content`), which becomes one hunk
 * of additions or removals; an update's diff, or text that already is one, stays as it is.
 */
function changeDiff(kind: unknown, diff: string): string {
  if ((kind !== 'add' && kind !== 'delete') || !diff || looksLikeDiff(diff)) return diff;
  const lines = diff.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const n = lines.length;
  return kind === 'add'
    ? `@@ -0,0 +1,${n} @@\n${lines.map(line => `+${line}`).join('\n')}\n`
    : `@@ -1,${n} +0,0 @@\n${lines.map(line => `-${line}`).join('\n')}\n`;
}

/**
 * Codex's native fileChange, webSearch, mcpToolCall and collabAgentToolCall items as tool calls,
 * `done` when Codex reported the item completed; undefined for any other item.
 */
export function codexToolCall(item: any, done: boolean): CodexToolCall | undefined {
  const raw = String(item?.status ?? '');
  // An item without a status (a web search) is running until Codex says it completed.
  const status = raw === 'inProgress' || (!raw && !done) ? 'running' : raw === 'failed' || raw === 'declined' ? 'failed' : 'completed';
  const failed = (error?: unknown) => status === 'failed' ? { error: toolError(error) } : {};

  if (item?.type === 'fileChange') {
    const changes = (Array.isArray(item.changes) ? item.changes : []).filter((change: any) => str(change?.path));
    if (!changes.length) return { name: 'apply_patch', status, detail: { type: 'unknown', input: item.changes ?? null, output: null }, ...failed() };
    let detail: ToolCallDetail;
    if (changes.length === 1) {
      const [change] = changes;
      const diff = typeof change.diff === 'string' ? change.diff : '';
      const kind = change.kind?.type ?? change.kind;
      detail = kind === 'add' && !looksLikeDiff(diff)
        ? typed({ type: 'write', filePath: change.path, content: diff || undefined })
        : typed({ type: 'edit', filePath: change.path, unifiedDiff: changeDiff(kind, diff) || undefined });
    } else {
      const diff = changes.map((change: any) => {
        const text = typeof change.diff === 'string' ? changeDiff(change.kind?.type ?? change.kind, change.diff) : '';
        return text ? withHeaders(change.path, text.endsWith('\n') ? text : `${text}\n`) : `--- a/${change.path}\n+++ b/${change.path}\n`;
      }).join('');
      detail = typed({ type: 'edit', filePath: changes[0].path, unifiedDiff: diff });
    }
    return { name: 'apply_patch', status, detail, ...failed() };
  }

  if (item?.type === 'webSearch') {
    const query = str(item.query) ?? str(item.action?.query) ?? (Array.isArray(item.action?.queries) ? str(item.action.queries[0]) : undefined) ?? '';
    return { name: 'web_search', status, detail: typed({ type: 'search', query, toolName: 'web_search' }), ...failed() };
  }

  if (item?.type === 'mcpToolCall') {
    return { name: `mcp__${String(item.server ?? '')}__${String(item.tool ?? '')}`, status, detail: { type: 'unknown', input: item.arguments ?? null, output: item.result ?? null }, ...failed(item.error?.message) };
  }

  if (item?.type === 'collabAgentToolCall') {
    return { name: 'Sub-agent', status, detail: typed({ type: 'sub_agent', subAgentType: 'Sub-agent', description: str(item.prompt) }), ...failed(item.error?.message) };
  }
  return undefined;
}
