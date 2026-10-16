import * as React from 'react';
import { cn } from '../lib/utils';

/**
 * A small, safe reading of the Markdown agents write: fenced code, headings, lists, quotes, bold
 * and inline code. Text only: nothing becomes HTML, links stay plain text.
 */

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'paragraph'; text: string };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) body.push(lines[j++]);
      blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
      i = j;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      const last = blocks.at(-1);
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(bullet[2]);
      else blocks.push({ kind: 'list', ordered, items: [bullet[2]] });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === 'quote') last.text += `\n${quote[1]}`;
      else blocks.push({ kind: 'quote', text: quote[1] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Inline code and bold, everything else as text. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index} className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">{part.slice(1, -1)}</code>;
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn('space-y-2.5 break-words text-[14px] leading-relaxed text-foreground/95', className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre key={index} className="overflow-x-auto rounded-lg border border-border bg-background/80 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground/90">
                <code>{block.text}</code>
              </pre>
            );
          case 'heading':
            return <p key={index} className={cn('font-semibold text-foreground', block.level <= 2 ? 'text-[15px]' : 'text-[14px]')}><Inline text={block.text} /></p>;
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={index} className={cn('space-y-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc marker:text-muted-foreground')}>
                {block.items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} /></li>)}
              </List>
            );
          }
          case 'quote':
            return <blockquote key={index} className="border-l-2 border-primary/40 pl-3 text-muted-foreground whitespace-pre-wrap"><Inline text={block.text} /></blockquote>;
          default:
            return <p key={index} className="whitespace-pre-wrap"><Inline text={block.text} /></p>;
        }
      })}
    </div>
  );
}
