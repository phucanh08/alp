import * as React from 'react';
import type { PanelKind } from './panels';
import { useAppState, useController } from './store';
import { orderTabs, updateLayout, loadLayout, moveKey, workspaceScope, workspaceTabs } from '../lib/layout.js';
import { layoutStorage } from './layoutStorage';
import { closeRange, planClose } from '../lib/tab-close.js';

/*
 * The center column's tabs, as in Paseo's workspace: one tab per agent of the open session that
 * the user opened (the main agent first), one per task opened from the Tasks list, and one per
 * panel opened from the + menu (Terminal, Diff, Tasks…). An agent tab shows that agent's
 * conversation; a task tab shows the task in full; a panel tab shows the panel.
 *
 * Agent tabs follow the controller: the open session's root and the agent in focus. Task and
 * panel tabs belong to the workspace and stay while sessions change.
 *
 * The draft tab is Paseo's new agent tab: the New session screen (composer, team/model/thinking
 * pickers, preview). One at a time; it stays in front while its session is being created and
 * gives way to the new session's tab once it is.
 *
 * As Paseo's workspace layout: the tabs can be dragged into another order, and each workspace's
 * tabs (the open session and its agent tabs, task and panel tabs, their order, the active tab)
 * are kept across reloads (lib/layout.js). The draft is not kept.
 */

export type Tab = { kind: 'agent'; id: string } | { kind: 'task'; id: string } | { kind: 'panel'; id: PanelKind } | { kind: 'draft'; id: 'new' };

export const DRAFT_TAB: Tab = { kind: 'draft', id: 'new' };

export const tabKey = (tab: Tab) => `${tab.kind}:${tab.id}`;

type TabsValue = {
  tabs: Tab[];
  active: Tab | null;
  activate: (tab: Tab) => void;
  close: (tab: Tab) => void;
  /**
   * Paseo's tab menu: close the tabs left of / right of / other than `tab`. If the active tab
   * closes, `tab` comes to the front; an active tab that stays keeps the front.
   */
  closeOthers: (tab: Tab, which: 'left' | 'right' | 'others') => void;
  /** Drag reorder: `tab` moves to index `to` of the row. */
  move: (tab: Tab, to: number) => void;
  openTask: (id: string) => void;
  openAgent: (id: string) => void;
  openPanel: (kind: PanelKind) => void;
  openDraft: () => void;
  /** The draft's session started: the draft closes and the session's tab comes to the front. */
  finishDraft: (id: string) => void;
};

const TabsContext = React.createContext<TabsValue | null>(null);

export function useTabs() {
  const value = React.useContext(TabsContext);
  if (!value) throw new Error('useTabs outside TabsProvider');
  return value;
}

const parseKey = (key: string | undefined): Tab | null => {
  if (!key) return null;
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (!id) return null;
  if (kind === 'agent' || kind === 'task') return { kind, id };
  if (kind === 'panel') return { kind, id: id as PanelKind };
  return null;
};

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const controller = useController();
  const { selected, focus, workspace, connection, sessions, tree } = useAppState();
  const [agents, setAgents] = React.useState<string[]>([]);
  const [tasks, setTasks] = React.useState<string[]>([]);
  const [panels, setPanels] = React.useState<PanelKind[]>([]);
  const [draft, setDraft] = React.useState(false);
  const [active, setActive] = React.useState<Tab | null>(null);
  const [order, setOrder] = React.useState<string[]>([]);
  const scope = workspace ? workspaceScope(connection.gateway, workspace) : null;
  // The workspace whose saved tabs the state holds: nothing is saved before they are restored.
  const [loaded, setLoaded] = React.useState<string | null>(null);
  // A saved session (and its agent tabs, the active tab) waiting for the session list.
  // Tried once: after its first selection it ends when its tree attaches (or fails) or when the
  // user opens something else.
  const restore = React.useRef<{ session: string; agents: string[]; active?: string; attempted?: boolean } | null>(null);
  // A focus change this provider made itself (closing a focused agent's tab): the focus effect
  // keeps the tab it chose in front.
  const ownFocus = React.useRef<string | null>(null);
  const focusQuietly = React.useCallback((id: string) => {
    const before = controller.getState().focus;
    controller.focusSession(id);
    const after = controller.getState().focus;
    if (after !== before) ownFocus.current = after;
  }, [controller]);

  // A new session: its main agent's tab, in front; but a session the draft is creating stays
  // behind the draft until it is ready (finishDraft), so a failure shows on the draft.
  React.useEffect(() => {
    const pending = restore.current;
    if (pending && (selected ? pending.session !== selected : pending.attempted)) restore.current = null;
    setAgents(selected ? [selected] : []);
    setActive(current => {
      if (current?.kind === 'draft' && controller.getState().busy.create) return current;
      if (selected && pending?.session === selected && pending.active) {
        const saved = parseKey(pending.active);
        if (saved && saved.kind !== 'agent') return saved;
      }
      return selected ? { kind: 'agent', id: selected } : current && current.kind !== 'agent' ? current : null;
    });
  }, [selected, controller]);

  // Task, panel and draft tabs belong to one workspace: its saved ones come back.
  React.useEffect(() => {
    const saved = scope ? workspaceTabs(loadLayout(layoutStorage()), scope) : undefined;
    setTasks(saved?.tasks ?? []);
    setPanels((saved?.panels ?? []) as PanelKind[]);
    setOrder(saved?.order ?? []);
    setDraft(false);
    const savedActive = parseKey(saved?.active);
    restore.current = saved?.session ? { session: saved.session, agents: saved.agents, active: saved.active } : null;
    setActive(current => {
      if (savedActive && savedActive.kind !== 'agent' && (savedActive.kind === 'task' ? saved?.tasks.includes(savedActive.id) : saved?.panels.includes(savedActive.id))) return savedActive;
      return current && current.kind !== 'agent' ? null : current;
    });
    setLoaded(scope);
  }, [scope]);

  // The saved session opens once the list shows it is still there (not archived, not gone); a
  // session the user opened meanwhile wins.
  React.useEffect(() => {
    const pending = restore.current;
    if (!pending || pending.attempted || selected || sessions.status !== 'ready') return;
    // A New session draft opened meanwhile stays in front.
    if (active?.kind !== 'draft' && sessions.list.some(session => session.id === pending.session)) {
      pending.attempted = true;
      controller.selectSession(pending.session);
    } else restore.current = null;
  }, [sessions, selected, active, controller]);

  // The saved agent tabs of that session come back as its tree shows them.
  React.useEffect(() => {
    const pending = restore.current;
    if (!pending || !tree || tree.rootId !== selected || pending.session !== selected) return;
    if (tree.status === 'gone' || tree.status === 'error') { restore.current = null; return; }
    if (tree.status !== 'attached') return;
    // Attached: the agents its tree still has come back; the restore is over.
    restore.current = null;
    const known = pending.agents.filter(id => tree.projection.sessions[id]);
    if (!known.length) return;
    setAgents(current => [...current, ...known.filter(id => !current.includes(id))]);
    const savedActive = parseKey(pending.active);
    if (savedActive?.kind === 'agent' && known.includes(savedActive.id)) {
      controller.focusSession(savedActive.id);
      setActive(savedActive);
    }
  }, [tree, selected, controller]);

  // An agent brought into focus from anywhere (the Agents list, a delegation) gets its tab.
  React.useEffect(() => {
    if (!focus || !selected) return;
    setAgents(current => current.includes(focus) ? current : [...current, focus]);
    if (ownFocus.current === focus) { ownFocus.current = null; return; }
    setActive(current => current && restore.current?.session === selected && focus === selected && current.kind !== 'agent' ? current : { kind: 'agent', id: focus });
  }, [focus, selected]);

  const tabs = React.useMemo<Tab[]>(() => orderTabs([
    ...agents.map(id => ({ kind: 'agent' as const, id })),
    ...tasks.map(id => ({ kind: 'task' as const, id })),
    ...panels.map(id => ({ kind: 'panel' as const, id })),
    ...(draft ? [DRAFT_TAB] : []),
  ], tabKey, order), [agents, tasks, panels, draft, order]);

  // Kept across reloads, once this workspace's saved tabs are in the state.
  React.useEffect(() => {
    if (!scope || loaded !== scope) return;
    const session = selected ?? restore.current?.session;
    const shown = tabs.filter(tab => tab.kind !== 'draft').map(tabKey);
    updateLayout(layoutStorage(), layout => ({
      ...layout,
      workspaces: {
        ...layout.workspaces,
        [scope]: {
          ...(session ? { session } : {}),
          agents: session ? [...agents.filter(id => id !== session), ...(restore.current?.agents ?? [])] : [],
          tasks, panels, order: shown,
          ...(active && active.kind !== 'draft' ? { active: tabKey(active) } : restore.current?.active ? { active: restore.current.active } : {}),
          at: Date.now(),
        },
      },
    }));
  }, [scope, loaded, selected, agents, tasks, panels, tabs, active]);

  /** A tab the user brings forward while a saved session is still to open: that tab stays in front. */
  const userChose = (tab: Tab) => { const pending = restore.current; if (pending && tab.kind !== 'agent') pending.active = tabKey(tab); };

  const activate = React.useCallback((tab: Tab) => {
    if (tab.kind === 'agent') controller.focusSession(tab.id);
    userChose(tab);
    setActive(tab);
  }, [controller]);

  /**
   * Closes `closing` together. `keep`, when given, comes to the front if the active tab closes;
   * otherwise the tab beside the closed active one does. The draft stays while its session starts.
   */
  const closeTabs = React.useCallback((closing: Tab[], keep?: Tab) => {
    const busy = !!controller.getState().busy.create;
    let list = closing;
    if (busy && list.some(tab => tab.kind === 'draft')) {
      controller.notify('info', 'The new session is still starting. Its tab opens once it is ready.');
      list = list.filter(tab => tab.kind !== 'draft');
    }
    if (!list.length) return;
    const keys = new Set(list.map(tabKey));
    const { closingRoot, next: planned } = planClose({ tabs, active, selected, closing: list, keep });
    // The plan's tab objects are the row's: the active one keeps its identity.
    const next = planned as Tab | null;
    restore.current = null;
    setAgents(current => closingRoot ? [] : current.filter(id => !keys.has(`agent:${id}`)));
    setTasks(current => current.filter(id => !keys.has(`task:${id}`)));
    setPanels(current => current.filter(id => !keys.has(`panel:${id}`)));
    if (keys.has(tabKey(DRAFT_TAB))) setDraft(false);
    // Closing the main agent's tab closes the session view; its work goes on on the host.
    if (closingRoot) controller.selectSession(null);
    else if (next?.kind === 'agent') controller.focusSession(next.id);
    else if (focus && keys.has(`agent:${focus}`) && selected) focusQuietly(selected);
    setActive(next);
  }, [tabs, active, selected, focus, controller, focusQuietly]);

  const close = React.useCallback((tab: Tab) => closeTabs([tab]), [closeTabs]);

  const closeOthers = React.useCallback((tab: Tab, which: 'left' | 'right' | 'others') => {
    const closing = closeRange(tabs, tab, which, selected) as Tab[];
    if (!closing.length) return;
    closeTabs(closing, tab);
  }, [tabs, selected, closeTabs]);

  const move = React.useCallback((tab: Tab, to: number) => {
    setOrder(moveKey(tabs.map(tabKey), tabKey(tab), to));
  }, [tabs]);

  const openTask = React.useCallback((id: string) => {
    setTasks(current => current.includes(id) ? current : [...current, id]);
    userChose({ kind: 'task', id });
    setActive({ kind: 'task', id });
  }, []);

  const openAgent = React.useCallback((id: string) => {
    controller.focusSession(id);
    setAgents(current => current.includes(id) ? current : [...current, id]);
    setActive({ kind: 'agent', id });
  }, [controller]);

  const openPanel = React.useCallback((kind: PanelKind) => {
    setPanels(current => current.includes(kind) ? current : [...current, kind]);
    userChose({ kind: 'panel', id: kind });
    setActive({ kind: 'panel', id: kind });
  }, []);

  const openDraft = React.useCallback(() => {
    setDraft(true);
    setActive(DRAFT_TAB);
  }, []);

  const finishDraft = React.useCallback((id: string) => {
    setDraft(false);
    setActive(current => current?.kind !== 'draft' ? current : controller.getState().selected === id ? { kind: 'agent', id } : null);
  }, [controller]);

  const value = React.useMemo(() => ({ tabs, active, activate, close, closeOthers, move, openTask, openAgent, openPanel, openDraft, finishDraft }), [tabs, active, activate, close, closeOthers, move, openTask, openAgent, openPanel, openDraft, finishDraft]);
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}
