import * as React from 'react';
import { Tokens, fenceFilename, useHighlightedLines } from '../lib/syntax';
import { cn } from '../lib/utils';
import { parseBlocks, type Block } from './chat/markdown';
import type { FileTarget } from '../lib/file-links.js';
import { INLINE, splitLink } from '../lib/inline-markdown.js';

/**
 * A small, safe reading of the Markdown agents write, styled as Paseo's assistant markdown:
 * paragraphs, headings, nested lists, quotes, fenced code, tables, rules, and inline bold, italic,
 * strike, code and links. Nothing becomes raw HTML; only http(s) and mailto links are live, and,
 * where a FileLinks context is given (an agent's reply, where the token may read files), inline code
 * and link targets that name a workspace file, which open it in a file tab (Paseo's file links).
 */

/** Resolves a token to a workspace file and opens it; given by the chat for agents' replies only. */
export type FileLinks = { resolve: (raw: string, kind: 'code' | 'href') => FileTarget | undefined; open: (target: FileTarget) => void };
export const FileLinkContext = React.createContext<FileLinks | null>(null);

const fileLinkClass = 'cursor-pointer text-highlight underline-offset-2 hover:underline focus-visible:underline outline-none';

function FileLinkButton({ target, links, children, title }: { target: FileTarget; links: FileLinks; children: React.ReactNode; title: string }) {
  return (
    <button type="button" className={cn('inline break-words text-left [overflow-wrap:anywhere]', fileLinkClass)} title={title} data-testid="chat-file-link" data-path={target.path}
      onClick={() => links.open(target)}><FileLinkContext.Provider value={null}>{children}</FileLinkContext.Provider></button>
  );
}

export { parseBlocks };

// INLINE's spans are bounded (lib/inline-markdown.js), so a long line costs a linear scan.
const safeHref = (url: string) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : undefined);

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const url = safeHref(href);
  if (!url) return <>{children}</>;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="break-words text-highlight [overflow-wrap:anywhere] hover:underline"><FileLinkContext.Provider value={null}>{children}</FileLinkContext.Provider></a>;
}

/** Inline code, bold, italic, strike and links; everything else as text. */
function Inline({ text }: { text: string }) {
  const links = React.useContext(FileLinkContext);
  const out: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) { out.push(rest); break; }
    if (match.index) out.push(rest.slice(0, match.index));
    const [token, code, strong, strike, link, url, em] = match;
    if (code) {
      const inner = code.slice(1, -1);
      const target = links?.resolve(inner, 'code');
      const element = <code className={cn('rounded-md bg-muted px-1 py-0.5 font-mono text-(length:--code-font-size)', target ? 'text-highlight' : 'text-foreground')}>{inner}</code>;
      out.push(target && links ? <FileLinkButton key={key++} target={target} links={links} title={`Open ${target.path}${target.line ? `:${target.line}` : ''}`}>{element}</FileLinkButton> : <React.Fragment key={key++}>{element}</React.Fragment>);
    }
    else if (strong) out.push(<strong key={key++} className="font-semibold text-foreground"><Inline text={strong.slice(2, -2)} /></strong>);
    else if (strike) out.push(<s key={key++} className="text-muted-foreground"><Inline text={strike.slice(2, -2)} /></s>);
    else if (link) {
      const parts = splitLink(link);
      const target = !parts || safeHref(parts.href) ? undefined : links?.resolve(parts.href, 'href');
      if (!parts) out.push(link);
      else out.push(target && links
        ? <FileLinkButton key={key++} target={target} links={links} title={`Open ${target.path}${target.line ? `:${target.line}` : ''}`}><Inline text={parts.text} /></FileLinkButton>
        : <Link key={key++} href={parts.href}><Inline text={parts.text} /></Link>);
    } else if (url) out.push(<Link key={key++} href={url}>{url}</Link>);
    else if (em) out.push(<em key={key++} className="italic"><Inline text={em.slice(1, -1)} /></em>);
    rest = rest.slice(match.index + token.length);
  }
  return <>{out}</>;
}

const HEADING = ['', 'mt-6 mb-3 border-b border-border pb-2 text-[1.867em] leading-[1.286] font-bold', 'mt-6 mb-3 border-b border-border pb-2 text-[1.6em] leading-[1.292] font-bold',
  'mt-4 mb-2 text-[1.4em] leading-[1.333] font-semibold', 'mt-4 mb-2 text-[1.267em] leading-[1.316] font-semibold', 'mt-3 mb-1 text-[1.133em] leading-[1.294] font-semibold',
  'mt-3 mb-1 text-[1.133em] leading-[1.294] font-semibold uppercase tracking-[0.5px] text-muted-foreground'];

function Blocks({ blocks, nested }: { blocks: Block[]; nested?: boolean }) {
  return (
    <>
      {blocks.map((block, index) => {
        const next = blocks[index + 1];
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={index} text={block.text} lang={block.lang} />;
          case 'heading': {
            const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
            return <Tag key={index} className={cn('text-foreground first:mt-0', HEADING[block.level])}><Inline text={block.text} /></Tag>;
          }
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            const after = nested ? 'mb-0' : !next ? 'mb-0' : next.kind === 'list' ? 'mb-2' : 'mb-4';
            return (
              <List key={index} className={cn('mt-1 pl-2.5', after)} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="mb-1 flex items-start">
                    <span aria-hidden className={cn('mr-1 shrink-0 select-none text-muted-foreground', block.ordered && 'min-w-3')}>{block.ordered ? `${block.start + itemIndex}.` : '•'}</span>
                    <div className="min-w-0 flex-1">
                      <Inline text={item.text} />
                      {item.children.length ? <Blocks blocks={item.children} nested /> : null}
                    </div>
                  </li>
                ))}
              </List>
            );
          }
          case 'quote':
            return (
              <blockquote key={index} className="my-3 whitespace-pre-wrap rounded-r-md border-l-4 border-muted bg-card px-4 py-3 text-foreground/80">
                <Inline text={block.text} />
              </blockquote>
            );
          case 'table':
            return (
              <div key={index} className="my-3 overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-muted">
                    <tr>{block.head.map((cell, cellIndex) => <th key={cellIndex} className="border-b border-r border-border p-2 font-semibold last:border-r-0"><Inline text={cell} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-border last:border-b-0">
                        {block.head.map((_, cellIndex) => <td key={cellIndex} className="border-r border-border p-2 align-top last:border-r-0"><Inline text={row[cellIndex] ?? ''} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr key={index} className="my-2.5 border-0 border-t border-border" />;
          default:
            return <p key={index} className={cn('whitespace-pre-wrap', nested ? 'mb-0' : 'mb-3')}><Inline text={block.text} /></p>;
        }
      })}
    </>
  );
}

/** A fenced code block in its language's syntax colors (Paseo's HighlightedCodeBlock). */
function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const lines = useHighlightedLines(text, fenceFilename(lang));
  return (
    <pre className="my-3 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-(length:--code-font-size) leading-[1.5] text-foreground" data-language={lang || undefined}>
      <code>{lines ? lines.map((line, index) => <React.Fragment key={index}>{index ? '\n' : null}<Tokens tokens={line} /></React.Fragment>) : text}</code>
    </pre>
  );
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn('min-w-0 break-words text-(length:--content-font-size) leading-[1.4] text-foreground [overflow-wrap:anywhere]', className)}>
      <Blocks blocks={blocks} />
    </div>
  );
}
