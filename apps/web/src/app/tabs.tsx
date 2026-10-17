import * as React from 'react';
import type { PanelKind } from './panels';
import { useAppState, useController } from './store';

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
 */

export type Tab = { kind: 'agent'; id: string } | { kind: 'task'; id: string } | { kind: 'panel'; id: PanelKind } | { kind: 'draft'; id: 'new' };

export const DRAFT_TAB: Tab = { kind: 'draft', id: 'new' };

export const tabKey = (tab: Tab) => `${tab.kind}:${tab.id}`;

type TabsValue = {
  tabs: Tab[];
  active: Tab | null;
  activate: (tab: Tab) => void;
  close: (tab: Tab) => void;
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

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const controller = useController();
  const { selected, focus, workspace } = useAppState();
  const [agents, setAgents] = React.useState<string[]>([]);
  const [tasks, setTasks] = React.useState<string[]>([]);
  const [panels, setPanels] = React.useState<PanelKind[]>([]);
  const [draft, setDraft] = React.useState(false);
  const [active, setActive] = React.useState<Tab | null>(null);

  // A new session: its main agent's tab, in front; but a session the draft is creating stays
  // behind the draft until it is ready (finishDraft), so a failure shows on the draft.
  React.useEffect(() => {
    setAgents(selected ? [selected] : []);
    setActive(current => {
      if (current?.kind === 'draft' && controller.getState().busy.create) return current;
      return selected ? { kind: 'agent', id: selected } : current && current.kind !== 'agent' ? current : null;
    });
  }, [selected, controller]);

  // Task, panel and draft tabs belong to one workspace.
  React.useEffect(() => {
    setTasks([]);
    setPanels([]);
    setDraft(false);
    setActive(current => current && current.kind !== 'agent' ? null : current);
  }, [workspace]);

  // An agent brought into focus from anywhere (the Agents list, a delegation) gets its tab.
  React.useEffect(() => {
    if (!focus || !selected) return;
    setAgents(current => current.includes(focus) ? current : [...current, focus]);
    setActive({ kind: 'agent', id: focus });
  }, [focus, selected]);

  const tabs = React.useMemo<Tab[]>(() => [
    ...agents.map(id => ({ kind: 'agent' as const, id })),
    ...tasks.map(id => ({ kind: 'task' as const, id })),
    ...panels.map(id => ({ kind: 'panel' as const, id })),
    ...(draft ? [DRAFT_TAB] : []),
  ], [agents, tasks, panels, draft]);

  const activate = React.useCallback((tab: Tab) => {
    if (tab.kind === 'agent') controller.focusSession(tab.id);
    setActive(tab);
  }, [controller]);

  const close = React.useCallback((tab: Tab) => {
    // The draft shows how its start ends (a refusal, with the message kept): not closed meanwhile.
    if (tab.kind === 'draft' && controller.getState().busy.create) {
      controller.notify('info', 'The new session is still starting. Its tab opens once it is ready.');
      return;
    }
    const index = tabs.findIndex(entry => tabKey(entry) === tabKey(tab));
    const rest = tabs.filter(entry => tabKey(entry) !== tabKey(tab));
    const closingActive = active && tabKey(active) === tabKey(tab);
    if (tab.kind === 'agent' && tab.id === selected) {
      // Closing the main agent's tab closes the session view; its work goes on on the host.
      const left = rest.filter(entry => entry.kind !== 'agent');
      setActive(closingActive ? left[0] ?? null : active && active.kind !== 'agent' ? active : left[0] ?? null);
      controller.selectSession(null);
      return;
    }
    if (tab.kind === 'agent') {
      setAgents(current => current.filter(id => id !== tab.id));
      if (focus === tab.id && selected) controller.focusSession(selected);
    } else if (tab.kind === 'draft') {
      setDraft(false);
    } else if (tab.kind === 'task') {
      setTasks(current => current.filter(id => id !== tab.id));
    } else {
      setPanels(current => current.filter(id => id !== tab.id));
    }
    if (closingActive) {
      const next = rest[Math.min(index, rest.length - 1)] ?? null;
      if (next?.kind === 'agent') controller.focusSession(next.id);
      setActive(next);
    }
  }, [tabs, active, selected, focus, controller]);

  const openTask = React.useCallback((id: string) => {
    setTasks(current => current.includes(id) ? current : [...current, id]);
    setActive({ kind: 'task', id });
  }, []);

  const openAgent = React.useCallback((id: string) => {
    controller.focusSession(id);
    setAgents(current => current.includes(id) ? current : [...current, id]);
    setActive({ kind: 'agent', id });
  }, [controller]);

  const openPanel = React.useCallback((kind: PanelKind) => {
    setPanels(current => current.includes(kind) ? current : [...current, kind]);
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

  const value = React.useMemo(() => ({ tabs, active, activate, close, openTask, openAgent, openPanel, openDraft, finishDraft }), [tabs, active, activate, close, openTask, openAgent, openPanel, openDraft, finishDraft]);
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}
