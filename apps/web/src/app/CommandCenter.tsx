import * as React from 'react';
import { commandResults, type CommandAction, type CommandSession } from '../lib/command-center.js';
import { cn } from '../lib/utils';
import { StatusIndicator } from './status';

export type RunnableAction = CommandAction & { icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; run: () => void };

/**
 * Paseo's command center (command-center/command-center.tsx), opened with Mod+K: a search over
 * the app's and the workspace's actions and the workspace's sessions. Arrow keys move (and wrap),
 * Enter runs the row and closes, Escape, Mod+K or a click outside closes; focus goes back to where
 * it was.
 */
export function CommandCenter({ open, onClose, actions, sessions, onOpenSession, mac }: {
  open: boolean;
  onClose: () => void;
  actions: RunnableAction[];
  sessions: CommandSession[];
  onOpenSession: (id: string) => void;
  mac: boolean;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const results = React.useRef<HTMLDivElement>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listId = React.useId();

  React.useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setActiveIndex(0);
      element.showModal();
      input.current?.focus();
    }
    if (!open && element.open) {
      element.close();
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected) target.focus();
    }
  }, [open]);

  const sections = React.useMemo(() => open ? commandResults({ actions: actions.filter(action => !action.disabled), sessions, query }) : [], [open, actions, sessions, query]);
  const rows = sections.flatMap(section => section.rows);
  const active = Math.min(activeIndex, Math.max(0, rows.length - 1));
  const byId = new Map(actions.map(action => [action.id, action]));

  React.useEffect(() => {
    results.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    onClose();
    if (row.kind === 'session') onOpenSession(row.item.id);
    // After the dialog closed and focus went back: an action may move focus on its own.
    else setTimeout(() => byId.get(row.item.id)?.run(), 0);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!rows.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((active + delta + rows.length) % rows.length);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(active);
    } else if (event.key.toLowerCase() === 'k' && (mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onClose();
    }
  };

  let index = -1;
  return (
    <dialog ref={dialog} aria-label="Command center" data-testid="command-center-panel"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === dialog.current) onClose(); }}
      className="mx-auto mt-12 mb-auto w-[min(92vw,640px)] max-h-[min(80dvh,560px)] overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-2xl shadow-[var(--shadow)] backdrop:bg-black/50">
      {open ? (
        <div className="flex max-h-[min(80dvh,560px)] flex-col" onKeyDown={onKeyDown}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3" data-testid="command-center-header">
            <input ref={input} type="text" role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
              aria-label="Search commands and sessions" placeholder="Search commands, sessions and agents..." value={query} autoComplete="off" spellCheck={false}
              onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} data-testid="command-center-input"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
          </div>
          <div ref={results} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="command-center-results">
            {rows.length === 0 ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">No matches</p> : sections.map((section, sectionIndex) => (
              <div key={section.id} role="group" aria-label={section.title} className={cn(sectionIndex > 0 && 'mt-1 border-t border-border pt-1')}>
                <div className="px-4 pb-1 pt-2 text-xs text-muted-foreground" aria-hidden>{section.title}</div>
                {section.rows.map(row => {
                  index += 1;
                  const at = index;
                  const selected = at === active;
                  if (row.kind === 'session') {
                    return (
                      <div key={`session:${row.item.id}`} id={`${listId}-${at}`} role="option" aria-selected={selected} data-index={at} data-testid={`command-center-session-${row.item.id}`}
                        onMouseMove={() => { if (!selected) setActiveIndex(at); }} onClick={() => choose(at)}
                        className={cn('flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2', selected && 'bg-secondary')}>
                        <StatusIndicator bucket={row.item.bucket} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm leading-[18px] text-foreground">{row.item.title}</div>
                          {row.item.subtitle ? <div className="truncate text-xs leading-4 text-muted-foreground" data-testid="command-center-session-subtitle">{row.item.subtitle}</div> : null}
                        </div>
                      </div>
                    );
                  }
                  const action = byId.get(row.item.id);
                  const Icon = action?.icon;
                  return (
                    <div key={`action:${row.item.id}`} id={`${listId}-${at}`} role="option" aria-selected={selected} data-index={at} data-testid={`command-center-action-${row.item.id}`}
                      onMouseMove={() => { if (!selected) setActiveIndex(at); }} onClick={() => choose(at)}
                      className={cn('flex min-h-9 cursor-pointer items-center gap-3 px-4 py-2', selected && 'bg-secondary')}>
                      <span className="flex w-4 shrink-0 justify-center text-muted-foreground">{Icon ? <Icon aria-hidden className="size-4" /> : null}</span>
                      <span className="min-w-0 flex-1 truncate text-sm leading-[18px] text-foreground">{row.item.label}</span>
                      {row.item.shortcut ? <kbd className="shrink-0 rounded bg-secondary px-1.5 py-px font-sans text-xs text-muted-foreground">{row.item.shortcut}</kbd> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
