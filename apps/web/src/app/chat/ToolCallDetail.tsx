import * as React from 'react';
import { cn } from '../../lib/utils';
import { LINE_LIMIT, asText, clipLines, detailKind, editDiff, relativePath, safeLink, splitLines, type DiffLine } from '../../lib/tool-calls.js';
import { RichText } from '../RichText';
import { Tokens, useHighlightedLines } from '../../lib/syntax';

/**
 * The open body of a tool call, per detail type as Paseo's tool-call-details.tsx (b63a325): a
 * shell command and its output, a read or written file with a line gutter, an edit as a diff, a
 * search's matches, files and web results, a fetch, a sub-agent's task and log, a plan as
 * markdown, plain text, and the input/output of anything else. Long bodies show their first
 * LINE_LIMIT lines and a control for more, so a huge file or diff cannot stall the page.
 */

type Item = { name?: string; status?: 'running' | 'completed' | 'failed'; error?: string; detail?: any };

/** A monospace block as Paseo's tool detail shows one: full bleed on surface 1, scrolls both ways. */
export function Code({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <pre className={cn('max-h-[360px] overflow-auto bg-card p-3 font-mono text-(length:--code-font-size) leading-[1.5] whitespace-pre', tone === 'error' ? 'text-destructive' : 'text-foreground')}>{children}</pre>
  );
}

/** "Show N more lines" under a clipped body. */
function useClip<T>(lines: T[]) {
  const [limit, setLimit] = React.useState(LINE_LIMIT);
  const { shown, hidden } = clipLines(lines, limit);
  const more = hidden ? (
    <button type="button" data-testid="tool-detail-more" onClick={() => setLimit(value => value + LINE_LIMIT)}
      className="sticky left-0 block px-3 py-1.5 font-sans text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {`Show ${Math.min(hidden, LINE_LIMIT)} more line${Math.min(hidden, LINE_LIMIT) === 1 ? '' : 's'}`}{hidden > LINE_LIMIT ? ` (${hidden} hidden)` : ''}
    </button>
  ) : null;
  return { shown, more };
}

const scroller = 'max-h-[360px] overflow-auto bg-card font-mono text-(length:--code-font-size) leading-[1.5] text-foreground';

/** Text as lines, with a line-number gutter from `startLine` when given; a file's lines in its syntax colors (Paseo's HighlightedLines). */
function TextLines({ text, startLine, testId, filename }: { text: string; startLine?: number; testId?: string; filename?: string }) {
  const lines = React.useMemo(() => splitLines(text), [text]);
  const highlighted = useHighlightedLines(React.useMemo(() => lines.join('\n'), [lines]), filename);
  const tokens = highlighted?.length === lines.length ? highlighted : null;
  const { shown, more } = useClip(lines);
  const width = startLine != null ? String(startLine + lines.length - 1).length : 0;
  return (
    <div className={scroller} data-testid={testId}>
      <div className="min-w-max py-2">
        {shown.map((line, index) => (
          <div key={index} className="flex whitespace-pre px-3">
            {startLine != null ? <span aria-hidden className="mr-3 shrink-0 select-none text-right text-muted-foreground tabular-nums" style={{ minWidth: `${width}ch` }}>{startLine + index}</span> : null}
            <span>{tokens?.[index]?.length ? <Tokens tokens={tokens[index]} /> : line || ' '}</span>
          </div>
        ))}
      </div>
      {more}
    </div>
  );
}

const DIFF_ROW: Record<DiffLine['type'], string> = {
  add: 'bg-[rgba(46,160,67,0.15)]',
  remove: 'bg-[rgba(248,81,73,0.15)]',
  context: '',
  hunk: 'bg-muted/60 text-muted-foreground',
  file: 'bg-muted font-sans font-medium',
  meta: 'text-muted-foreground italic',
};
const SIGN: Record<DiffLine['type'], string> = { add: '+', remove: '-', context: ' ', hunk: '', file: '', meta: '' };

/** Paseo's DiffViewer: removed and added lines tinted, with old and new line numbers when they are the file's. */
function DiffView({ detail }: { detail: any }) {
  const { lines, numbered } = React.useMemo(() => editDiff(detail), [detail]);
  // The code lines highlighted together, in the file's syntax (meta, hunk and file rows stay plain).
  const code = React.useMemo(() => lines.filter(line => line.type === 'add' || line.type === 'remove' || line.type === 'context'), [lines]);
  const highlighted = useHighlightedLines(React.useMemo(() => code.map(line => line.text).join('\n'), [code]), typeof detail?.filePath === 'string' ? detail.filePath : null);
  const tokensOf = React.useMemo(() => {
    const map = new Map<DiffLine, NonNullable<typeof highlighted>[number]>();
    if (highlighted?.length === code.length) code.forEach((line, index) => map.set(line, highlighted[index]));
    return map;
  }, [code, highlighted]);
  const { shown, more } = useClip(lines);
  if (!lines.length) return <Empty>No changes to show.</Empty>;
  const width = numbered ? String(Math.max(0, ...lines.map(line => Math.max(line.oldLine ?? 0, line.newLine ?? 0)))).length : 0;
  const gutter = (value: number | undefined) => numbered
    ? <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={{ minWidth: `${width + 1}ch` }}>{value ?? ''}</span>
    : null;
  return (
    <div className={scroller} data-testid="tool-diff">
      <div className="min-w-max py-2">
        {shown.map((line, index) => line.type === 'hunk' || line.type === 'file' || line.type === 'meta' ? (
          <div key={index} className={cn('whitespace-pre px-3', DIFF_ROW[line.type], line.type === 'file' && index > 0 && 'mt-2')} data-diff={line.type}>{line.text}</div>
        ) : (
          <div key={index} className={cn('flex whitespace-pre px-3', DIFF_ROW[line.type])} data-diff={line.type}>
            {gutter(line.oldLine)}{gutter(line.newLine)}
            <span aria-hidden className={cn('w-[2ch] shrink-0 select-none', line.type === 'add' ? 'text-dot-success' : line.type === 'remove' ? 'text-destructive' : 'text-muted-foreground')}>{SIGN[line.type]}</span>
            <span>{tokensOf.get(line)?.length ? <Tokens tokens={tokensOf.get(line)!} /> : line.text || ' '}</span>
          </div>
        ))}
      </div>
      {more}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="bg-card px-3 py-2.5 text-sm text-muted-foreground">{children}</p>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="bg-card px-3 pt-2 text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

/** A link that leaves the app: http(s) only, else plain text. */
function OutLink({ url, children }: { url: string; children?: React.ReactNode }) {
  const href = safeLink(url);
  if (!href) return <span className="break-all">{children ?? url}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-foreground underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground">{children ?? url}</a>;
}

function SearchBody({ detail, roots }: { detail: any; roots: string[] }) {
  const files: string[] = Array.isArray(detail.filePaths) ? detail.filePaths.filter((path: unknown) => typeof path === 'string') : [];
  const web: Array<{ title?: string; url?: string }> = Array.isArray(detail.webResults) ? detail.webResults.filter((entry: any) => entry && typeof entry.url === 'string') : [];
  const counts = [
    typeof detail.numMatches === 'number' ? `${detail.numMatches} match${detail.numMatches === 1 ? '' : 'es'}` : '',
    typeof detail.numFiles === 'number' ? `${detail.numFiles} file${detail.numFiles === 1 ? '' : 's'}` : '',
    detail.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const content = typeof detail.content === 'string' ? detail.content : '';
  return (
    <>
      {counts ? <p className="bg-card px-3 pt-2 text-xs text-muted-foreground">{counts}</p> : null}
      {content ? <TextLines text={content} testId="tool-search-content" /> : null}
      {files.length ? <TextLines text={files.map(path => relativePath(path, roots)).join('\n')} testId="tool-search-files" /> : null}
      {web.length ? (
        <ul className="max-h-[360px] space-y-2 overflow-auto bg-card px-3 py-2.5 text-sm" data-testid="tool-search-web">
          {web.map((entry, index) => (
            <li key={index} className="min-w-0">
              <OutLink url={String(entry.url)}>{entry.title?.trim() || entry.url}</OutLink>
              {entry.title?.trim() ? <span className="block truncate text-xs text-muted-foreground">{entry.url}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function FetchBody({ detail }: { detail: any }) {
  const result = typeof detail.result === 'string' ? detail.result : '';
  return (
    <>
      <p className="bg-card px-3 py-2.5 font-mono text-(length:--code-font-size) leading-[1.5]">
        <OutLink url={String(detail.url ?? '')} />{typeof detail.code === 'number' ? <span className="ml-2 text-muted-foreground">{detail.code}</span> : null}
      </p>
      {typeof detail.prompt === 'string' && detail.prompt.trim() ? <Section title="Prompt"><p className="bg-card px-3 pb-2.5 pt-1 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{detail.prompt}</p></Section> : null}
      {result ? <TextLines text={result} testId="tool-fetch-result" /> : null}
    </>
  );
}

/** Today's view of a call without a typed detail (and of detail types this build does not know): its input and output. */
function UnknownBody({ detail }: { detail: any }) {
  const input = asText(detail?.input);
  const output = asText(detail?.output);
  return (
    <>
      {input ? <TextLines text={input} testId="tool-unknown-input" /> : null}
      {output ? <TextLines text={output} testId="tool-unknown-output" /> : null}
    </>
  );
}

function hasBody(kind: string, detail: any) {
  const has = (value: unknown) => typeof value === 'string' && value.length > 0;
  switch (kind) {
    case 'shell': return true;
    case 'read': case 'write': return has(detail.content);
    case 'edit': return has(detail.unifiedDiff) || has(detail.oldString) || has(detail.newString);
    case 'search': return has(detail.content) || detail.filePaths?.length > 0 || detail.webResults?.length > 0 || typeof detail.numFiles === 'number' || typeof detail.numMatches === 'number';
    case 'fetch': return has(detail.url) || has(detail.result);
    case 'sub_agent': return has(detail.description) || has(detail.log);
    case 'plan': return has(detail.text) && detail.text.trim().length > 0;
    case 'plain_text': return has(detail.text);
    default: return !!asText(detail?.input) || !!asText(detail?.output);
  }
}

/** The open body of one tool call. `roots`: where file paths are shown relative to. */
export function ToolCallBody({ item, roots }: { item: Item; roots: string[] }) {
  const detail = item.detail ?? {};
  const kind = detailKind(detail);
  const status = item.status;
  let body: React.ReactNode = null;
  switch (kind) {
    case 'shell': {
      const output = String(detail.output ?? '').replace(/^\n+/, '');
      body = <Code><span className="text-muted-foreground">$ </span>{String(detail.command ?? '').replace(/\n+$/, '')}{output ? `\n\n${output}` : status === 'running' ? '\n\nRunning…' : ''}</Code>;
      break;
    }
    case 'read':
      if (hasBody(kind, detail)) body = <TextLines text={detail.content} startLine={Number.isInteger(detail.offset) && detail.offset > 0 ? detail.offset : 1} testId="tool-file-content" filename={detail.filePath} />;
      break;
    case 'write':
      if (hasBody(kind, detail)) body = <TextLines text={detail.content} startLine={1} testId="tool-file-content" filename={detail.filePath} />;
      break;
    case 'edit':
      if (hasBody(kind, detail)) body = <DiffView detail={detail} />;
      break;
    case 'search':
      if (hasBody(kind, detail)) body = <SearchBody detail={detail} roots={roots} />;
      break;
    case 'fetch':
      if (hasBody(kind, detail)) body = <FetchBody detail={detail} />;
      break;
    case 'sub_agent':
      if (hasBody(kind, detail)) body = (
        <>
          {typeof detail.description === 'string' && detail.description.trim() ? <p className="bg-card px-3 py-2.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="tool-sub-agent-description">{detail.description}</p> : null}
          {typeof detail.log === 'string' && detail.log.trim() ? <TextLines text={detail.log.replace(/^\n+/, '')} testId="tool-sub-agent-log" /> : null}
        </>
      );
      break;
    case 'plan':
      if (hasBody(kind, detail)) body = <div className="max-h-[480px] overflow-auto bg-card px-4 py-3" data-testid="tool-plan"><RichText text={detail.text} className="text-sm leading-5" /></div>;
      break;
    case 'plain_text':
      if (hasBody(kind, detail)) body = <p className="max-h-[360px] overflow-auto bg-card px-3 py-2.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{detail.text}</p>;
      break;
    default:
      if (hasBody(kind, detail)) body = <UnknownBody detail={detail} />;
  }
  return (
    <div className="divide-y divide-border">
      {body}
      {item.error ? <Code tone="error">{item.error}</Code> : null}
      {!body && !item.error ? <Empty>{status === 'running' ? 'Running…' : 'No output.'}</Empty> : null}
    </div>
  );
}
