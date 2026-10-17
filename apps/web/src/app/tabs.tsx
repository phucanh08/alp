import * as React from 'react';
import type { PanelKind } from './panels';
import { useAppState, useController } from './store';
import { orderTabs, updateLayout, loadLayout, moveKey, workspaceScope, workspaceTabs } from '../lib/layout.js';
import { layoutStorage } from './layoutStorage';
import { closeRange, planClose } from '../lib/tab-close.js';
import { adjacentPane, moveToPane, nearestPane, paneIds, paneOf, removePane, resizeGroup, singlePane, splitPane, tabsByPane, type Direction, type Panes, type SplitPosition } from '../lib/panes.js';

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
 *
 * As Paseo's split panes (lib/panes.js): the center can split into panes, each with its own tab
 * row. A tab sits in one pane; one pane has focus, and `active` is the tab in front there (the
 * other panes show their own). New tabs open in the focused pane; a pane whose last tab closes
 * goes away (the last pane stays). Splitting a pane opens a New tab in the new pane, as Paseo's:
 * a launcher (Agent, the panels) that turns into what is picked.
 */

export type Tab = { kind: 'agent'; id: string } | { kind: 'task'; id: string } | { kind: 'panel'; id: PanelKind } | { kind: 'draft'; id: 'new' } | { kind: 'launcher'; id: string };

/** Tabs that are not kept across reloads (Paseo's ephemeral tabs): the draft and New tab launchers. */
const ephemeral = (tab: Tab) => tab.kind === 'draft' || tab.kind === 'launcher';

export const DRAFT_TAB: Tab = { kind: 'draft', id: 'new' };

export const tabKey = (tab: Tab) => `${tab.kind}:${tab.id}`;

type TabsValue = {
  /** Every open tab, all panes. */
  tabs: Tab[];
  /** The focused pane's tabs: what the tab actions (next, previous, 1-9) go through. */
  row: Tab[];
  /** The tab in front in the focused pane. */
  active: Tab | null;
  panes: Panes;
  byPane: Record<string, Tab[]>;
  focusedPane: string;
  /** The tab a pane shows. */
  activeOf: (paneId: string) => Tab | null;
  focusPane: (paneId: string) => void;
  /** Paseo's Split pane right / down: a new pane beside the focused one with a New tab. */
  splitEmpty: (position: 'right' | 'bottom') => void;
  /** Whether splitEmpty can run now. */
  canSplitEmpty: boolean;
  /** A New tab picked: it gives way to `open`'s tab, in its pane. */
  launch: (launcher: string, open: () => void) => void;
  /** A tab dropped on a pane's edge: that pane splits and the tab moves into the new pane. */
  splitWith: (tab: Tab, target: string, position: SplitPosition) => void;
  /** A tab moved into another pane (at `index` of its row, else at its end) and shown there. */
  moveTabToPane: (tab: Tab, paneId: string, index?: number) => void;
  /** Closes a pane with its tabs (not the last pane). */
  closePane: (paneId: string) => void;
  focusAdjacent: (direction: Direction) => boolean;
  moveTabAdjacent: (direction: Direction) => boolean;
  resize: (groupId: string, sizes: number[]) => void;
  maximized: string | null;
  toggleMaximized: (paneId: string) => void;
  activate: (tab: Tab) => void;
  close: (tab: Tab) => void;
  /**
   * Paseo's tab menu: close the tabs left of / right of / other than `tab` in its pane's row (or
   * `row`, the row shown). If the active tab closes, `tab` comes to the front; an active tab that
   * stays keeps the front.
   */
  closeOthers: (tab: Tab, which: 'left' | 'right' | 'others', row?: Tab[]) => void;
  /** Drag reorder: `tab` moves to index `to` of its pane's row (of all tabs when `whole`). */
  move: (tab: Tab, to: number, whole?: boolean) => void;
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
  const [launchers, setLaunchers] = React.useState<string[]>([]);
  const [active, setActive] = React.useState<Tab | null>(null);
  const [order, setOrder] = React.useState<string[]>([]);
  const [panes, setPanes] = React.useState<Panes>(singlePane);
  const [maximized, setMaximized] = React.useState<string | null>(null);
  const scope = workspace ? workspaceScope(connection.gateway, workspace) : null;
  // The workspace whose saved tabs the state holds: nothing is saved before they are restored.
  const [loaded, setLoaded] = React.useState<string | null>(null);
  // A saved session (and its agent tabs, the active tab) waiting for the session list.
  // Tried once: after its first selection it ends when its tree attaches (or fails) or when the
  // user opens something else.
  const restore = React.useRef<{ session: string; agents: string[]; active?: string; attempted?: boolean } | null>(null);
  // While a restore is pending, panes waiting for their saved agent tabs stay though empty.
  const [restoring, setRestoring] = React.useState(false);
  const endRestore = React.useCallback(() => { restore.current = null; setRestoring(false); }, []);
  /** The agent tabs a pending restore brings back (the session's own first): they keep their pane. */
  const restoredKeys = () => {
    const pending = restore.current;
    return new Set(pending ? [pending.session, ...pending.agents].map(id => `agent:${id}`) : []);
  };
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
    if (pending && (selected ? pending.session !== selected : pending.attempted)) endRestore();
    setAgents(selected ? [selected] : []);
    setActive(current => {
      if (current?.kind === 'draft' && controller.getState().busy.create) return current;
      if (selected && pending?.session === selected && pending.active) {
        const saved = parseKey(pending.active);
        if (saved && saved.kind !== 'agent') return saved;
      }
      return selected ? { kind: 'agent', id: selected } : current && current.kind !== 'agent' ? current : null;
    });
  }, [selected, controller, endRestore]);

  // Task, panel and draft tabs belong to one workspace: its saved ones come back, with its panes.
  React.useEffect(() => {
    const saved = scope ? workspaceTabs(loadLayout(layoutStorage()), scope) : undefined;
    setTasks(saved?.tasks ?? []);
    setPanels((saved?.panels ?? []) as PanelKind[]);
    setOrder(saved?.order ?? []);
    // A saved pane left with no tab kept (it held a New tab or the draft) gets a New tab, as
    // Paseo's restoreEmptyPanesInNode.
    const savedPanes = saved?.panes ?? singlePane();
    const filled = new Set(Object.values(savedPanes.assign));
    const fresh = paneIds(savedPanes.root).length > 1 ? paneIds(savedPanes.root).filter(id => !filled.has(id)).map((pane, index) => ({ pane, id: `n${index + 1}` })) : [];
    setPanes(fresh.length ? { ...savedPanes, assign: { ...savedPanes.assign, ...Object.fromEntries(fresh.map(entry => [`launcher:${entry.id}`, entry.pane])) } } : savedPanes);
    setMaximized(null);
    setDraft(false);
    setLaunchers(fresh.map(entry => entry.id));
    const savedActive = parseKey(saved?.active);
    restore.current = saved?.session ? { session: saved.session, agents: saved.agents, active: saved.active } : null;
    setRestoring(!!saved?.session);
    // The focused pane's fresh New tab is in front when nothing else is.
    const focusedFresh = fresh.find(entry => entry.pane === savedPanes.focused);
    setActive(current => {
      if (savedActive && savedActive.kind !== 'agent' && (savedActive.kind === 'task' ? saved?.tasks.includes(savedActive.id) : saved?.panels.includes(savedActive.id))) return savedActive;
      const next = current && current.kind !== 'agent' ? null : current;
      return next ?? (focusedFresh ? { kind: 'launcher', id: focusedFresh.id } : null);
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
    } else endRestore();
  }, [sessions, selected, active, controller, endRestore]);

  // The saved agent tabs of that session come back as its tree shows them.
  React.useEffect(() => {
    const pending = restore.current;
    if (!pending || !tree || tree.rootId !== selected || pending.session !== selected) return;
    if (tree.status === 'gone' || tree.status === 'error') { endRestore(); return; }
    if (tree.status !== 'attached') return;
    // Attached: the agents its tree still has come back; the restore is over.
    endRestore();
    const known = pending.agents.filter(id => tree.projection.sessions[id]);
    if (!known.length) return;
    setAgents(current => [...current, ...known.filter(id => !current.includes(id))]);
    const savedActive = parseKey(pending.active);
    if (savedActive?.kind === 'agent' && known.includes(savedActive.id)) {
      controller.focusSession(savedActive.id);
      setActive(savedActive);
    }
  }, [tree, selected, controller, endRestore]);

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
    ...launchers.map(id => ({ kind: 'launcher' as const, id })),
  ], tabKey, order), [agents, tasks, panels, draft, launchers, order]);

  // The panes: which tabs each holds, which has focus (the active tab's), what each shows.
  const ids = React.useMemo(() => paneIds(panes.root), [panes.root]);
  const byPane = React.useMemo(() => tabsByPane(panes, tabs, tabKey), [panes, tabs]);
  const focusedPane = active ? paneOf(panes, tabKey(active)) : ids.includes(panes.focused) ? panes.focused : ids[0];
  const row = byPane[focusedPane] ?? [];
  const activeOf = React.useCallback((paneId: string): Tab | null => {
    if (paneId === focusedPane) return active;
    const list = byPane[paneId] ?? [];
    const key = panes.actives[paneId];
    return list.find(tab => tabKey(tab) === key) ?? list[0] ?? null;
  }, [focusedPane, active, byPane, panes.actives]);

  // Kept in step: the focused pane, the tab in front of each, and where new tabs sit (the pane
  // that had focus when they opened). Tabs that closed lose their place, except the saved agent
  // tabs a restore still waits for.
  React.useEffect(() => {
    // Not while another workspace's tabs are still in the state.
    if (loaded !== scope) return;
    setPanes(current => {
      const open = new Set(tabs.map(tabKey));
      const waiting = restoredKeys();
      const known = paneIds(current.root);
      let changed = false;
      const assign: Record<string, string> = {};
      for (const [key, pane] of Object.entries(current.assign)) {
        if ((open.has(key) || waiting.has(key)) && known.includes(pane)) assign[key] = pane; else changed = true;
      }
      for (const key of open) if (!assign[key]) { assign[key] = focusedPane; changed = true; }
      let actives = current.actives;
      const shown = active ? tabKey(active) : null;
      if (shown && open.has(shown) && actives[focusedPane] !== shown) { actives = { ...actives, [focusedPane]: shown }; changed = true; }
      if (current.focused !== focusedPane) changed = true;
      return changed ? { ...current, focused: focusedPane, assign, actives } : current;
    });
  }, [loaded, scope, tabs, active, focusedPane]);

  // A pane left with no tab goes (Paseo removes it with its last tab); the last pane stays.
  React.useEffect(() => {
    if (loaded !== scope || restoring || ids.length < 2) return;
    const empty = ids.filter(id => !(byPane[id] ?? []).length);
    if (!empty.length) return;
    setPanes(current => {
      let next = current;
      for (const id of empty) next = removePane(next, id) ?? next;
      return next;
    });
  }, [loaded, scope, restoring, ids, byPane]);
  React.useEffect(() => { if (maximized && (!ids.includes(maximized) || ids.length < 2)) setMaximized(null); }, [maximized, ids]);

  // Kept across reloads, once this workspace's saved tabs are in the state.
  React.useEffect(() => {
    if (!scope || loaded !== scope) return;
    const session = selected ?? restore.current?.session;
    const shown = tabs.filter(tab => !ephemeral(tab)).map(tabKey);
    const kept = new Set([...shown, ...restoredKeys()]);
    const split = ids.length > 1 ? {
      root: panes.root,
      focused: focusedPane,
      assign: Object.fromEntries(Object.entries(panes.assign).filter(([key]) => kept.has(key))),
      actives: Object.fromEntries(Object.entries(panes.actives).filter(([, key]) => kept.has(key))),
    } : undefined;
    updateLayout(layoutStorage(), layout => ({
      ...layout,
      workspaces: {
        ...layout.workspaces,
        [scope]: {
          ...(session ? { session } : {}),
          agents: session ? [...agents.filter(id => id !== session), ...(restore.current?.agents ?? [])] : [],
          tasks, panels, order: shown,
          ...(active && !ephemeral(active) ? { active: tabKey(active) } : restore.current?.active ? { active: restore.current.active } : {}),
          ...(split ? { panes: split } : {}),
          at: Date.now(),
        },
      },
    }));
  }, [scope, loaded, selected, agents, tasks, panels, tabs, active, ids, panes, focusedPane]);

  /** A tab the user brings forward while a saved session is still to open: that tab stays in front. */
  const userChose = (tab: Tab) => { const pending = restore.current; if (pending && !ephemeral(tab)) pending.active = tabKey(tab); };

  const activate = React.useCallback((tab: Tab) => {
    if (tab.kind === 'agent') controller.focusSession(tab.id);
    userChose(tab);
    setActive(tab);
  }, [controller]);

  /**
   * Closes `closing` together. `keep`, when given, comes to the front if the active tab closes;
   * otherwise the tab beside the closed active one in its pane does; a pane left empty gives the
   * focus to the pane beside it. The draft stays while its session starts.
   */
  const closeTabs = React.useCallback((closing: Tab[], keep?: Tab) => {
    const creating = !!controller.getState().busy.create;
    let list = closing;
    if (creating && list.some(tab => tab.kind === 'draft')) {
      controller.notify('info', 'The new session is still starting. Its tab opens once it is ready.');
      list = list.filter(tab => tab.kind !== 'draft');
    }
    if (!list.length) return;
    const keys = new Set(list.map(tabKey));
    // Each pane's tab in front after the close, from its own row (the plan's tab objects are the
    // row's, so the active one keeps its identity).
    let closingRoot = false;
    const after: Record<string, Tab | null> = {};
    for (const id of ids) {
      const paneTabs = byPane[id] ?? [];
      const shown = id === focusedPane ? active : activeOf(id);
      const plan = planClose({ tabs: paneTabs, active: shown, selected, closing: list, keep: keep && paneTabs.some(tab => tabKey(tab) === tabKey(keep)) ? keep : undefined });
      closingRoot ||= plan.closingRoot;
      after[id] = plan.next as Tab | null;
    }
    let next = after[focusedPane] ?? null;
    if (!next && ids.length > 1) {
      // The focused pane is left empty: the focus goes to the pane beside it.
      const beside = nearestPane(panes.root, focusedPane);
      next = (beside ? after[beside] : null) ?? ids.map(id => after[id]).find(Boolean) ?? null;
    }
    endRestore();
    setAgents(current => closingRoot ? [] : current.filter(id => !keys.has(`agent:${id}`)));
    setTasks(current => current.filter(id => !keys.has(`task:${id}`)));
    setPanels(current => current.filter(id => !keys.has(`panel:${id}`)));
    if (keys.has(tabKey(DRAFT_TAB))) setDraft(false);
    setLaunchers(current => current.filter(id => !keys.has(`launcher:${id}`)));
    setPanes(current => ({ ...current, actives: Object.fromEntries(ids.flatMap(id => after[id] ? [[id, tabKey(after[id] as Tab)]] : [])) }));
    // Closing the main agent's tab closes the session view; its work goes on on the host.
    if (closingRoot) controller.selectSession(null);
    else if (next?.kind === 'agent') controller.focusSession(next.id);
    else if (focus && keys.has(`agent:${focus}`) && selected) focusQuietly(selected);
    setActive(next);
  }, [ids, byPane, focusedPane, active, activeOf, panes.root, selected, focus, controller, focusQuietly, endRestore]);

  const close = React.useCallback((tab: Tab) => closeTabs([tab]), [closeTabs]);

  const closeOthers = React.useCallback((tab: Tab, which: 'left' | 'right' | 'others', row?: Tab[]) => {
    const closing = closeRange(row ?? byPane[paneOf(panes, tabKey(tab))] ?? [], tab, which, selected) as Tab[];
    if (!closing.length) return;
    closeTabs(closing, tab);
  }, [byPane, panes, selected, closeTabs]);

  /** The row's order with `tab` placed at `to` among the tabs of pane `paneId`. */
  const placeIn = React.useCallback((tab: Tab, paneId: string, to: number) => {
    const key = tabKey(tab);
    const keys = tabs.map(tabKey);
    const inPane = new Set((byPane[paneId] ?? []).map(tabKey));
    inPane.delete(key);
    const local = moveKey([...keys.filter(entry => inPane.has(entry)), key], key, to);
    // The pane's tabs keep the places they had in the whole row, in their new order; a tab that
    // joins the pane takes a place right after the pane's last tab.
    const rest = keys.filter(entry => entry !== key);
    const slots = rest.flatMap((entry, index) => inPane.has(entry) ? [index] : []);
    const insertAt = slots.length ? slots[slots.length - 1] + 1 : rest.length;
    const merged = [...rest.slice(0, insertAt), key, ...rest.slice(insertAt)];
    let at = 0;
    return merged.map(entry => entry === key || inPane.has(entry) ? local[at++] : entry);
  }, [tabs, byPane]);

  const move = React.useCallback((tab: Tab, to: number, whole?: boolean) => {
    setOrder(whole ? moveKey(tabs.map(tabKey), tabKey(tab), to) : placeIn(tab, paneOf(panes, tabKey(tab)), to));
  }, [tabs, placeIn, panes]);

  const focusPane = React.useCallback((paneId: string) => {
    if (paneId === focusedPane || !ids.includes(paneId)) return;
    const shown = activeOf(paneId);
    if (shown) activate(shown);
    else { setPanes(current => ({ ...current, focused: paneId })); setActive(null); }
  }, [focusedPane, ids, activeOf, activate]);

  /** The pane a tab leaves shows the tab beside it, as after a close (Paseo's successor). */
  const leaving = React.useCallback((current: Panes, tab: Tab): Panes => {
    const source = paneOf(current, tabKey(tab));
    const shown = activeOf(source);
    if (!shown || tabKey(shown) !== tabKey(tab)) return current;
    const next = planClose({ tabs: byPane[source] ?? [], active: tab, selected: null, closing: [tab] }).next as Tab | null;
    const actives = { ...current.actives };
    if (next) actives[source] = tabKey(next); else delete actives[source];
    return { ...current, actives };
  }, [activeOf, byPane]);

  const moveTabToPane = React.useCallback((tab: Tab, paneId: string, index?: number) => {
    if (!ids.includes(paneId)) return;
    const target = (byPane[paneId] ?? []).filter(entry => tabKey(entry) !== tabKey(tab));
    setOrder(placeIn(tab, paneId, index ?? target.length));
    setPanes(current => moveToPane(leaving(current, tab), tabKey(tab), paneId));
    activate(tab);
  }, [ids, byPane, placeIn, leaving, activate]);

  const splitWith = React.useCallback((tab: Tab, target: string, position: SplitPosition) => {
    const source = paneOf(panes, tabKey(tab));
    // A pane's only tab split off that same pane would leave nothing behind.
    if (source === target && (byPane[source] ?? []).length < 2) return;
    const next = splitPane(leaving(panes, tab), { target, position, key: tabKey(tab) });
    if (!next) return;
    setPanes(next);
    activate(tab);
  }, [panes, byPane, leaving, activate]);

  const canSplitEmpty = !!workspace;
  const splitEmpty = React.useCallback((position: 'right' | 'bottom') => {
    if (!canSplitEmpty) return;
    const used = new Set(launchers);
    let n = 1;
    while (used.has(`n${n}`)) n += 1;
    const launcher: Tab = { kind: 'launcher', id: `n${n}` };
    const next = splitPane(panes, { target: focusedPane, position, key: tabKey(launcher) });
    if (!next) return;
    setPanes(next);
    setLaunchers(current => [...current, launcher.id]);
    setActive(launcher);
  }, [canSplitEmpty, launchers, panes, focusedPane]);

  const launch = React.useCallback((launcher: string, open: () => void) => {
    const key = `launcher:${launcher}`;
    const pane = paneOf(panes, key);
    // What opens lands in the launcher's pane (an open tab elsewhere comes forward there).
    setPanes(current => ({ ...current, focused: pane }));
    setLaunchers(current => current.filter(id => id !== launcher));
    open();
  }, [panes]);

  const closePane = React.useCallback((paneId: string) => {
    if (ids.length < 2 || !ids.includes(paneId)) return;
    const paneTabs = byPane[paneId] ?? [];
    if (paneTabs.length) closeTabs(paneTabs);
    else setPanes(current => removePane(current, paneId) ?? current);
  }, [ids, byPane, closeTabs]);

  const focusAdjacent = React.useCallback((direction: Direction) => {
    const target = adjacentPane(panes.root, focusedPane, direction);
    if (!target) return false;
    focusPane(target);
    return true;
  }, [panes.root, focusedPane, focusPane]);

  const moveTabAdjacent = React.useCallback((direction: Direction) => {
    const target = adjacentPane(panes.root, focusedPane, direction);
    if (!target || !active) return false;
    moveTabToPane(active, target);
    return true;
  }, [panes.root, focusedPane, active, moveTabToPane]);

  const resize = React.useCallback((groupId: string, sizes: number[]) => setPanes(current => resizeGroup(current, groupId, sizes)), []);
  const toggleMaximized = React.useCallback((paneId: string) => setMaximized(current => current === paneId ? null : paneId), []);

  const openTask = React.useCallback((id: string) => {
    setTasks(current => current.includes(id) ? current : [...current, id]);
    userChose({ kind: 'task', id });
    setActive({ kind: 'task', id });
  }, []);

  const openAgent = React.useCallback((id: string) => {
    controller.focusSession(id);
    setAgents(current => current.includes(id) ? current : [...current, id]);
    userChose({ kind: 'agent', id });
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

  const value = React.useMemo(() => ({
    tabs, row, active, panes, byPane, focusedPane, activeOf, focusPane, splitEmpty, canSplitEmpty, launch, splitWith, moveTabToPane, closePane, focusAdjacent, moveTabAdjacent, resize, maximized, toggleMaximized,
    activate, close, closeOthers, move, openTask, openAgent, openPanel, openDraft, finishDraft,
  }), [tabs, row, active, panes, byPane, focusedPane, activeOf, focusPane, splitEmpty, canSplitEmpty, launch, splitWith, moveTabToPane, closePane, focusAdjacent, moveTabAdjacent, resize, maximized, toggleMaximized,
    activate, close, closeOthers, move, openTask, openAgent, openPanel, openDraft, finishDraft]);
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}
