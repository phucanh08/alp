import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { Menu } from '../components/ui/menu';
import { cn } from '../lib/utils';
import { PANELS, PanelView, type PanelKind } from './panels';
import { useAppState } from './store';
import { TabChip } from './TabChip';

/*
 * The right panel, as Paseo 0.14's explorer dock: Files then Changes by default, both kept (no
 * close button: Paseo's explorer singletons), other panels open as closable tabs, and + is a menu
 * of the panels not open yet (Paseo's New tab menu for the explorer).
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/**
 * What the dock's + offers, in Paseo's supporting launch order, then ALP's panels. Not Terminal: a
 * terminal is a shell on the host owned by one center tab, which ends it when it closes (#121 H).
 */
const DOCK_LAUNCH: PanelKind[] = ['changes', 'diff', 'files', 'agents', 'tasks'];

/** Paseo's explorer singletons (panel-manifest showCloseButton: false): always in the dock. */
const KEPT: ReadonlySet<PanelKind> = new Set(['files', 'changes']);

/*
 * The dock's tabs. The state lives above the dock (App) so hiding the dock keeps its tabs.
 */
export type DockTab = { id: string; kind: PanelKind };
export type Dock = {
  tabs: DockTab[];
  active: string | null;
  select: (id: string) => void;
  close: (id: string) => void;
  /** Opens `kind`'s panel as a tab, or brings its tab to the front if it is open. */
  launch: (kind: PanelKind) => void;
};

export function useDock(initial: PanelKind[] = ['files', 'changes']): Dock {
  const [state, setState] = React.useState<{ tabs: DockTab[]; active: string | null }>(() => ({
    tabs: initial.map(kind => ({ id: kind, kind })),
    active: initial[0] ?? null,
  }));
  const select = React.useCallback((id: string) => setState(current => ({ ...current, active: id })), []);
  const close = React.useCallback((id: string) => setState(current => {
    if (KEPT.has(id as PanelKind)) return current;
    const index = current.tabs.findIndex(tab => tab.id === id);
    const tabs = current.tabs.filter(tab => tab.id !== id);
    const active = current.active !== id ? current.active : tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    return { tabs, active };
  }), []);
  // One tab per panel: an open one comes to the front.
  const launch = React.useCallback((kind: PanelKind) => setState(current => current.tabs.some(tab => tab.id === kind)
    ? { ...current, active: kind }
    : { tabs: [...current.tabs, { id: kind, kind }], active: kind }), []);
  return React.useMemo(() => ({ ...state, select, close, launch }), [state, select, close, launch]);
}

export function SidePanel({ dock, onClose }: { dock: Dock; onClose?: () => void }) {
  const { tree, tasks } = useAppState();
  const working = tree ? Object.keys(tree.projection.running).length : 0;
  const open = tasks.rows.filter(entry => entry.status !== 'closed').length;
  const count: Partial<Record<PanelKind, number>> = { agents: working, tasks: open };
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const active = dock.tabs.find(tab => tab.id === dock.active) ?? null;
  // Paseo's menu leaves out the singletons already in the dock; ALP's dock holds one tab per panel.
  const launchable = DOCK_LAUNCH.filter(kind => !dock.tabs.some(tab => tab.kind === kind));
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
            const panel = PANELS[tab.kind];
            return (
              <TabChip key={tab.id} tabRef={element => { refs.current[tab.id] = element; }} id={`dock-tab-${tab.id}`} aria-controls="dock-panel"
                tabIndex={tab.id === dock.active ? 0 : -1} testId="explorer-tab" data-tab={tab.id}
                label={panel.label} icon={<panel.icon aria-hidden className="size-3.5" />}
                badge={count[tab.kind]} active={tab.id === dock.active}
                onSelect={() => dock.select(tab.id)} onClose={KEPT.has(tab.kind) ? undefined : () => dock.close(tab.id)} />
            );
          })}
          <Menu label="New explorer tab" title="New tab" align="start" testId="workspace-new-tab-button" disabled={!launchable.length}
            trigger={<Plus aria-hidden className="size-3.5" />} triggerClassName={cn(railButton, 'mx-1 text-extra-muted')}
            items={launchable.map(kind => {
              const panel = PANELS[kind];
              return { label: panel.label, icon: <panel.icon aria-hidden />, testId: `workspace-new-tab-menu-${kind}`, onSelect: () => dock.launch(kind) };
            })} />
        </div>
        {onClose ? (
          <button type="button" aria-label="Close panel" onClick={onClose} className={cn(railButton, 'mr-1.5 size-8 rounded-lg')}>
            <X aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      <div {...(active ? { role: 'tabpanel', 'aria-labelledby': `dock-tab-${active.id}` } : {})} id="dock-panel" className="min-h-0 flex-1 overflow-y-auto">
        {active ? <PanelView kind={active.kind} onPicked={onClose} /> : null}
      </div>
    </aside>
  );
}

