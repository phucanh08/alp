import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { PANELS, PanelView, type PanelKind } from './panels';
import { useAppState } from './store';
import { TabChip } from './TabChip';

/*
 * The right panel, as Paseo's latest explorer dock: panels open as closable tabs (Changes and
 * Files by default), and + opens a New tab whose launcher turns it into the panel picked.
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/** What the dock's + offers, in Paseo's order for the dock, then ALP's panels. */
const DOCK_LAUNCH: PanelKind[] = ['changes', 'terminal', 'diff', 'files', 'agents', 'tasks'];

/*
 * The dock's tabs. The state lives above the dock (App) so hiding the dock keeps its tabs.
 */
export type DockTab = { id: string; kind: PanelKind | 'new' };
export type Dock = {
  tabs: DockTab[];
  active: string | null;
  select: (id: string) => void;
  close: (id: string) => void;
  /** Opens a New tab, or brings the one already open to the front. */
  openNew: () => void;
  /** Turns tab `replace` (a New tab) into `kind`'s panel, or brings `kind`'s tab to the front if it is open. */
  launch: (kind: PanelKind, replace?: string) => void;
};

export function useDock(initial: PanelKind[] = ['changes', 'files']): Dock {
  const [state, setState] = React.useState<{ tabs: DockTab[]; active: string | null }>(() => ({
    tabs: initial.map(kind => ({ id: kind, kind })),
    active: initial[0] ?? null,
  }));
  const select = React.useCallback((id: string) => setState(current => ({ ...current, active: id })), []);
  const close = React.useCallback((id: string) => setState(current => {
    const index = current.tabs.findIndex(tab => tab.id === id);
    const tabs = current.tabs.filter(tab => tab.id !== id);
    const active = current.active !== id ? current.active : tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    return { tabs, active };
  }), []);
  const openNew = React.useCallback(() => setState(current => current.tabs.some(tab => tab.kind === 'new')
    ? { ...current, active: 'new' }
    : { tabs: [...current.tabs, { id: 'new', kind: 'new' }], active: 'new' }), []);
  const launch = React.useCallback((kind: PanelKind, replace?: string) => setState(current => {
    // One tab per panel: an open one comes to the front and the New tab that asked goes away.
    if (current.tabs.some(tab => tab.id === kind)) return { tabs: current.tabs.filter(tab => tab.id !== replace), active: kind };
    const at = current.tabs.findIndex(tab => tab.id === replace);
    const tabs = at < 0 ? [...current.tabs, { id: kind, kind }] : current.tabs.map((tab, index) => index === at ? { id: kind, kind } : tab);
    return { tabs, active: kind };
  }), []);
  return React.useMemo(() => ({ ...state, select, close, openNew, launch }), [state, select, close, openNew, launch]);
}

/** Paseo's New tab panel: one row per panel, centered in the dock; arrows move between rows. */
function Launcher({ onLaunch, autoFocus }: { onLaunch: (kind: PanelKind) => void; autoFocus: boolean }) {
  const first = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => { if (autoFocus) first.current?.focus({ preventScroll: true }); }, [autoFocus]);
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + step + rows.length) % rows.length]?.focus();
  };
  return (
    <div className="flex min-h-full items-center justify-center p-6" data-testid="workspace-new-tab-panel">
      <div className="flex w-full max-w-[320px] flex-col gap-1" onKeyDown={onKey}>
        {DOCK_LAUNCH.map((kind, index) => {
          const panel = PANELS[kind];
          return (
          <button key={kind} ref={index === 0 ? first : undefined} type="button" onClick={() => onLaunch(kind)} data-testid={`workspace-new-tab-${kind}`}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-transparent bg-card px-3 text-left text-sm text-foreground outline-none hover:bg-secondary focus-visible:border-ring">
            <panel.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{panel.label}</span>
          </button>
          );
        })}
      </div>
    </div>
  );
}

export function SidePanel({ dock, onClose }: { dock: Dock; onClose?: () => void }) {
  const { tree, tasks } = useAppState();
  const working = tree ? Object.keys(tree.projection.running).length : 0;
  const open = tasks.rows.filter(entry => entry.status !== 'closed').length;
  const count: Partial<Record<PanelKind, number>> = { agents: working, tasks: open };
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const active = dock.tabs.find(tab => tab.id === dock.active) ?? null;
  const onKey = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step || !dock.tabs.length || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    event.preventDefault();
    const at = dock.tabs.findIndex(tab => tab.id === dock.active);
    const next = dock.tabs[(at + step + dock.tabs.length) % dock.tabs.length].id;
    dock.select(next);
    refs.current[next]?.focus();
  };
  const railButton = cn('flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground', focusRing);
  return (
    <aside aria-label="Explorer" className="flex h-full min-h-0 flex-col bg-sidebar" data-testid="workspace-explorer-sidebar">
      <div className="relative flex h-14 shrink-0 items-center border-b border-border md:h-9">
        <div role="tablist" aria-label="Explorer tabs" onKeyDown={onKey} className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none]">
          {dock.tabs.map(tab => {
            const panel = tab.kind === 'new' ? null : PANELS[tab.kind];
            return (
              <TabChip key={tab.id} tabRef={element => { refs.current[tab.id] = element; }} id={`dock-tab-${tab.id}`} aria-controls="dock-panel"
                tabIndex={tab.id === dock.active ? 0 : -1} testId="explorer-tab" data-tab={tab.id}
                label={panel?.label ?? 'New tab'} icon={panel ? <panel.icon aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />}
                badge={tab.kind === 'new' ? undefined : count[tab.kind]} active={tab.id === dock.active}
                onSelect={() => dock.select(tab.id)} onClose={() => dock.close(tab.id)} />
            );
          })}
          <button type="button" aria-label="New explorer tab" title="New tab" onClick={dock.openNew} className={cn(railButton, 'mx-1')}>
            <Plus aria-hidden className="size-4" />
          </button>
        </div>
        {onClose ? (
          <button type="button" aria-label="Close panel" onClick={onClose} className={cn(railButton, 'mr-1.5 size-8 rounded-lg')}>
            <X aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      <div {...(active ? { role: 'tabpanel', 'aria-labelledby': `dock-tab-${active.id}` } : {})} id="dock-panel" className="min-h-0 flex-1 overflow-y-auto">
        {!active || active.kind === 'new'
          ? <Launcher key={active?.id ?? 'empty'} autoFocus={!!active} onLaunch={kind => dock.launch(kind, active?.id)} />
          : <PanelView kind={active.kind} onPicked={onClose} />}
      </div>
    </aside>
  );
}

