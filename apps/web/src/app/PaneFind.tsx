import * as React from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { findMatches, findStatus, isFindShortcut, stepMatch, type FindSegment } from '../lib/pane-find.js';
import { isMacPlatform } from '../lib/shortcuts.js';
import { cn } from '../lib/utils';
import { usePaneFocused } from './pane';

/*
 * Paseo's pane-find for the chat (ALP.app has no browser find bar): Cmd/Ctrl+F in the focused pane
 * opens a find bar over the conversation. Matches are marked with the CSS Custom Highlight API, the
 * current one apart, and scrolled into view. Enter / Shift+Enter (or the arrows) move between them,
 * Escape closes. It searches what the conversation shows: a folded turn or a closed tool call is
 * not searched until it is open, and older messages until they are loaded.
 */

/** Tags that start a new block of text: a match does not run across them. */
const BLOCKS = new Set(['P', 'DIV', 'LI', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'BUTTON', 'SUMMARY', 'TR', 'UL', 'OL', 'TABLE']);

function blockOf(node: Node): Element | null {
  let element = node.parentElement;
  while (element && !BLOCKS.has(element.tagName)) element = element.parentElement;
  return element;
}

/** The text nodes of `root` a reader sees, in order, with where each block starts. */
function collect(root: HTMLElement): { nodes: Text[]; segments: FindSegment[] } {
  const nodes: Text[] = [];
  const segments: FindSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const parent = node.parentElement;
      if (!node.nodeValue || !parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[aria-hidden="true"], .sr-only, script, style, [data-find-skip]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let block: Element | null | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const own = blockOf(text);
    segments.push({ text: text.nodeValue ?? '', breakBefore: block !== undefined && own !== block });
    block = own;
    nodes.push(text);
  }
  return { nodes, segments };
}

// The highlights are the window's: each open find bar owns its ranges, and the registry shows them all.
const owned = new Map<string, { all: Range[]; current: Range | null }>();
function publish() {
  const registry = (globalThis as any).CSS?.highlights;
  const Highlight = (globalThis as any).Highlight;
  if (!registry || !Highlight) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const entry of owned.values()) { all.push(...entry.all); if (entry.current) current.push(entry.current); }
  if (all.length) registry.set('alp-find', new Highlight(...all)); else registry.delete('alp-find');
  if (current.length) registry.set('alp-find-current', new Highlight(...current)); else registry.delete('alp-find-current');
}

/**
 * The find bar of one conversation. `scroller` is what scrolls (the matches are searched in it, and
 * again as its text changes); `onReveal` runs before a match is scrolled to (the stream unpins).
 */
export function PaneFind({ scroller, onReveal }: { scroller: React.RefObject<HTMLElement | null>; onReveal?: () => void }) {
  const id = React.useId();
  const focused = usePaneFocused();
  const mac = React.useMemo(() => isMacPlatform(), []);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [current, setCurrent] = React.useState(0);
  const [result, setResult] = React.useState<{ ranges: Range[]; limited: boolean }>({ ranges: [], limited: false });
  const input = React.useRef<HTMLInputElement>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);
  const latest = React.useRef({ focused, open });
  latest.current = { focused, open };

  // Cmd/Ctrl+F in this pane: open (or select what is typed), and keep the browser's own find away.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isFindShortcut(event, mac) || !latest.current.focused) return;
      if (document.querySelector('dialog[open], [data-modal-overlay], [role="menu"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (!latest.current.open) returnTo.current = document.activeElement as HTMLElement | null;
      setOpen(true);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac]);

  // The matches, again whenever the conversation changes under an open bar.
  const search = React.useCallback(() => {
    const root = scroller.current;
    if (!root || !open || !query.trim()) { setResult({ ranges: [], limited: false }); return; }
    const { nodes, segments } = collect(root);
    const { matches, limited } = findMatches(segments, query);
    const ranges = matches.map(match => {
      const range = document.createRange();
      range.setStart(nodes[match.start.segment], match.start.offset);
      range.setEnd(nodes[match.end.segment], match.end.offset);
      return range;
    });
    setResult({ ranges, limited });
  }, [scroller, open, query]);
  React.useEffect(search, [search]);
  React.useEffect(() => {
    const root = scroller.current;
    if (!root || !open || typeof MutationObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(search, 150); });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [scroller, open, search]);

  const total = result.ranges.length;
  const at = total ? Math.min(current, total - 1) : 0;
  const currentRange = total ? result.ranges[at] : null;
  React.useEffect(() => {
    owned.set(id, { all: open ? result.ranges : [], current: open ? currentRange : null });
    publish();
  }, [id, open, result, currentRange]);
  React.useEffect(() => () => { owned.delete(id); publish(); }, [id]);

  // The current match in view: scrolled to the middle when it is out of sight.
  const reveal = React.useCallback((range: Range | null) => {
    const root = scroller.current;
    if (!root || !range) return;
    const box = range.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    if (box.top >= frame.top + 64 && box.bottom <= frame.bottom - 8) return;
    onReveal?.();
    root.scrollTop += box.top - frame.top - root.clientHeight / 2;
  }, [scroller, onReveal]);
  // Only a new query or a move scrolls: new text streaming in keeps the reader where they are.
  const revealed = React.useRef('');
  const revealKey = open && currentRange ? `${query}\0${at}` : '';
  React.useEffect(() => {
    if (!revealKey || revealKey === revealed.current) return;
    revealed.current = revealKey;
    reveal(currentRange);
  }, [revealKey, currentRange, reveal]);

  const move = (delta: 1 | -1) => { if (total) { setCurrent(stepMatch(at, total, delta)); revealed.current = ''; } };
  const close = () => {
    setOpen(false);
    const target = returnTo.current;
    returnTo.current = null;
    if (target?.isConnected) target.focus();
  };
  if (!open) return null;
  const status = findStatus(query, at, total, result.limited);
  const button = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5';
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-end px-4" data-find-skip>
      <div role="search" aria-label="Find" data-testid="pane-find"
        className="pointer-events-auto flex w-[min(100%,22rem)] items-center gap-1 rounded-lg border border-border bg-popover py-1 pl-2.5 pr-1 shadow-lg shadow-[var(--shadow)]">
        <input ref={input} type="text" aria-label="Find in pane" placeholder="Find in pane" value={query} autoComplete="off" spellCheck={false} data-testid="pane-find-input"
          onChange={event => { setQuery(event.target.value); setCurrent(0); revealed.current = ''; }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); close(); }
            else if (event.key.toLowerCase() === 'g' && (mac ? event.metaKey : event.ctrlKey)) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
        <span role="status" aria-live="polite" aria-label="Find matches" data-testid="pane-find-status"
          className={cn('shrink-0 px-1 text-xs tabular-nums text-muted-foreground', status === 'No matches' && 'text-destructive')}>{status}</span>
        <button type="button" className={button} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!total} onClick={() => move(-1)} data-testid="pane-find-previous"><ArrowUp aria-hidden /></button>
        <button type="button" className={button} aria-label="Next match" title="Next match (Enter)" disabled={!total} onClick={() => move(1)} data-testid="pane-find-next"><ArrowDown aria-hidden /></button>
        <button type="button" className={button} aria-label="Close Find" title="Close (Escape)" onClick={close} data-testid="pane-find-close"><X aria-hidden /></button>
      </div>
    </div>
  );
}
