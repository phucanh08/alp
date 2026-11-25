/**
 * Paseo 0.14's Chat display (Settings › Chat): how much of an agent's work the chat shows.
 *
 * - `full`: every tool call is its own row.
 * - `collapseToolCalls`: a run of two or more tool calls in a row becomes one row that says what
 *   they did ("Edited 2 files and ran 3 commands"), opening into the calls
 *   (tool-calls/detail-level grouping and overview).
 * - `collapseTurns`: the same, and each finished turn folds everything the agent did before its
 *   last reply into one line under the user's message; the reply stays in the chat
 *   (agent-stream/turn-collapse). The turn still running never folds.
 *
 * Plans (`todo` rows and `plan` details) never group, as in Paseo. Compaction stays visible in a
 * folded turn. Built from the timeline's entries only; nothing here reaches the host.
 */

export type Entry = import('./timeline.js').Entry;
export type ChatDisplay = 'full' | 'collapseToolCalls' | 'collapseTurns';
export type WorkSummary = { editedFileCount: number; commandCount: number; readFileCount: number; searchCount: number; otherToolCount: number; };
export type DisplayRow = { type: 'entry'; key: string; entry: Entry; nested?: boolean; } |
{ type: 'group'; key: string; entries: Entry[]; summary: WorkSummary; loading: boolean; } |
{ type: 'turn'; key: string; entries: Entry[]; summary: WorkSummary; expanded: boolean; };

// any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
const kindOf = (entry: Entry | undefined) => (entry?.item as any)?.kind;
// any: a timeline item is a union of host item kinds; the field read here exists only on some, and is checked.
const detailOf = (entry: Entry) => (entry.item as any)?.detail ?? {};

/** A tool call that may join a group: not a plan (Paseo's isGroupableToolCall). */
export function isGroupable(entry: Entry | undefined) {
  return kindOf(entry) === 'tool_call' && detailOf(entry as Entry).type !== 'plan';
}

/** A tool name that searches (Paseo's DIRECT_SEARCH_TOOL_SUFFIX_PATTERN, loosely). */
const searchName = (name: unknown) => typeof name === 'string' && /(^|[_.\-\s])(grep|glob|search|find)$/i.test(name.trim());

/**
 * Counts tool calls by what they did (Paseo's summarizeToolCalls): files edited or written and
 * files read count once each, commands and searches each time.
 */
export function summarizeWork(entries: Entry[]): WorkSummary {
  const edited = new Set();
  const read = new Set();
  let commandCount = 0;
  let searchCount = 0;
  let otherToolCount = 0;
  for (const entry of entries) {
    if (kindOf(entry) !== 'tool_call') continue;
    const detail = detailOf(entry);
    if (detail.type === 'edit' || detail.type === 'write') edited.add(detail.filePath ?? entry.key);
    else if (detail.type === 'shell') commandCount += 1;
    else if (detail.type === 'read') read.add(detail.filePath ?? entry.key);
    // any: a timeline item is a union of host item kinds; the field read here exists only on some, and is checked.
    else if (detail.type === 'search' || searchName((entry.item as any).name)) searchCount += 1;
    else otherToolCount += 1;
  }
  return { editedFileCount: edited.size, commandCount, readFileCount: read.size, searchCount, otherToolCount };
}

const hasWork = (summary: WorkSummary) => Object.values(summary).some(count => count > 0);

/**
 * One sentence of what a stretch of agent work did (Paseo's useOverviewSummaryLabel), e.g.
 * "Edited 2 files and ran 3 commands"; "" when it did nothing countable.
 */
export function summaryLabel(summary: WorkSummary) {
  const counts: Array<[number, string, string]> = [
    [summary.editedFileCount, 'edited {n} file', 'edited {n} files'],
    [summary.commandCount, 'ran {n} command', 'ran {n} commands'],
    [summary.readFileCount, 'read {n} file', 'read {n} files'],
    [summary.searchCount, 'searched {n} time', 'searched {n} times'],
    [summary.otherToolCount, 'used {n} other tool', 'used {n} other tools'],
  ];
  const parts = counts.filter(([count]) => count > 0).map(([count, one, other]) => (count === 1 ? one : other).replace('{n}', String(count)));
  if (!parts.length) return '';
  const joined = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
  return joined[0].toLocaleUpperCase() + joined.slice(1);
}

/**
 * The rows the chat shows for `entries` under `display`.
 *
 * @param options
 *   `expandedTurns` holds the keys of the user messages whose folded turn the reader opened;
 *   `isBoundary` marks rows that stand between turns (fork and rewind markers).
 */
export function displayRows(entries: Entry[], { display, running, expandedTurns = new Set(), isBoundary = () => false }: { display: ChatDisplay; running: boolean; expandedTurns?: ReadonlySet<string>; isBoundary?: (entry: Entry) => boolean; }): DisplayRow[] {
  const rows: DisplayRow[] = display === 'collapseTurns' ? foldTurns(entries, running, expandedTurns, isBoundary) : entries.map(entry => ({ type: 'entry', key: entry.key, entry }));
  return display === 'full' ? rows : groupToolCalls(rows);
}

/**
 * Each closed turn: its user message(s), then one turn row for the work before the last reply,
 * then the reply and what follows it.
 */
function foldTurns(entries: Entry[], running: boolean, expandedTurns: ReadonlySet<string>, isBoundary: (entry: Entry) => boolean): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const plain = (entry: Entry, nested?: boolean): DisplayRow => nested ? { type: 'entry', key: entry.key, entry, nested } : { type: 'entry', key: entry.key, entry };
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (kindOf(entry) !== 'user_message' || isBoundary(entry)) { rows.push(plain(entry)); index += 1; continue; }
    // The turn: the user message(s), then everything up to the next user message or boundary.
    let start = index;
    while (start < entries.length && kindOf(entries[start]) === 'user_message' && !isBoundary(entries[start])) start += 1;
    let end = start;
    while (end < entries.length && kindOf(entries[end]) !== 'user_message' && !isBoundary(entries[end])) end += 1;
    const host = entries[start - 1];
    for (let at = index; at < start; at += 1) rows.push(plain(entries[at]));
    const work = entries.slice(start, end);
    const closed = end < entries.length || !running;
    let reply = -1;
    for (let at = work.length - 1; at >= 0; at -= 1) if (kindOf(work[at]) === 'assistant_message') { reply = at; break; }
    const folded = reply > 0 ? work.slice(0, reply) : [];
    const summary = summarizeWork(folded);
    if (!closed || reply <= 0 || (!hasWork(summary) && !folded.some(item => kindOf(item) === 'assistant_message'))) {
      for (const item of work) rows.push(plain(item));
    } else {
      const expanded = expandedTurns.has(host.key);
      rows.push({ type: 'turn', key: `turn:${host.key}`, entries: folded, summary, expanded });
      for (const item of folded) if (expanded || kindOf(item) === 'compaction') rows.push(plain(item, expanded));
      for (const item of work.slice(reply)) rows.push(plain(item));
    }
    index = end;
  }
  return rows;
}

/** Runs of two or more groupable tool calls (never inside an opened turn) become one group row. */
function groupToolCalls(rows: DisplayRow[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  let run: Entry[] = [];
  const flush = () => {
    // any: a timeline item is a union of host item kinds; the field read here exists only on some, and is checked.
    if (run.length > 1) out.push({ type: 'group', key: `group:${run[0].key}`, entries: run, summary: summarizeWork(run), loading: run.some(entry => (entry.item as any).status === 'running') });
    else for (const entry of run) out.push({ type: 'entry', key: entry.key, entry });
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'entry' && !row.nested && isGroupable(row.entry)) { run.push(row.entry); continue; }
    flush();
    out.push(row);
  }
  flush();
  return out;
}
