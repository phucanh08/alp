import * as React from 'react';
import { useAppState, useController } from './store';

/*
 * The center column's tabs, as in Paseo's workspace: one tab per agent of the open session that
 * the user opened (the main agent first), and one per task opened from the Tasks list. An agent
 * tab shows that agent's conversation; a task tab shows the task in full.
 *
 * Agent tabs follow the controller: the open session's root and the agent in focus. Task tabs
 * belong to the workspace and stay while sessions change.
 */

export type Tab = { kind: 'agent'; id: string } | { kind: 'task'; id: string };

export const tabKey = (tab: Tab) => `${tab.kind}:${tab.id}`;

type TabsValue = {
  tabs: Tab[];
  active: Tab | null;
  activate: (tab: Tab) => void;
  close: (tab: Tab) => void;
  openTask: (id: string) => void;
  openAgent: (id: string) => void;
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
  const [active, setActive] = React.useState<Tab | null>(null);

  // A new session: its main agent's tab, in front.
  React.useEffect(() => {
    setAgents(selected ? [selected] : []);
    setActive(current => selected ? { kind: 'agent', id: selected } : current?.kind === 'task' ? current : null);
  }, [selected]);

  // Task tabs belong to one workspace.
  React.useEffect(() => {
    setTasks([]);
    setActive(current => current?.kind === 'task' ? null : current);
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
  ], [agents, tasks]);

  const activate = React.useCallback((tab: Tab) => {
    if (tab.kind === 'agent') controller.focusSession(tab.id);
    setActive(tab);
  }, [controller]);

  const close = React.useCallback((tab: Tab) => {
    const index = tabs.findIndex(entry => tabKey(entry) === tabKey(tab));
    const rest = tabs.filter(entry => tabKey(entry) !== tabKey(tab));
    const closingActive = active && tabKey(active) === tabKey(tab);
    if (tab.kind === 'agent' && tab.id === selected) {
      // Closing the main agent's tab closes the session view; its work goes on on the host.
      const left = rest.filter(entry => entry.kind === 'task');
      setActive(closingActive ? left[0] ?? null : active?.kind === 'task' ? active : left[0] ?? null);
      controller.selectSession(null);
      return;
    }
    if (tab.kind === 'agent') {
      setAgents(current => current.filter(id => id !== tab.id));
      if (focus === tab.id && selected) controller.focusSession(selected);
    } else {
      setTasks(current => current.filter(id => id !== tab.id));
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

  const value = React.useMemo(() => ({ tabs, active, activate, close, openTask, openAgent }), [tabs, active, activate, close, openTask, openAgent]);
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}
