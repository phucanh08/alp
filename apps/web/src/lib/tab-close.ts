/**
 * What closing tabs does to the tab row (app/tabs.tsx), as plain data so it can be tested: which
 * tabs a menu entry closes and which tab comes to the front after.
 *
 * Tabs are `{ kind, id }`; the session's own tab is the agent tab whose id is `selected`. Closing
 * it closes the session view and with it every agent tab.
 */

export type TabRef = { kind: string; id: string; };

export const keyOf = (tab: TabRef) => `${tab.kind}:${tab.id}`;

/**
 * The tabs Paseo's Close to the left / Close to the right / Close other tabs closes for `tab`.
 * When `tab` is one of the session's other agents, the session's own tab stays (it holds them).
 */
export function closeRange(tabs: TabRef[], tab: TabRef, which: 'left' | 'right' | 'others', selected: string | null): TabRef[] {
  const index = tabs.findIndex(entry => keyOf(entry) === keyOf(tab));
  if (index < 0) return [];
  let closing = which === 'left' ? tabs.slice(0, index) : which === 'right' ? tabs.slice(index + 1) : tabs.filter((_, at) => at !== index);
  if (tab.kind === 'agent' && tab.id !== selected) closing = closing.filter(entry => !(entry.kind === 'agent' && entry.id === selected));
  return closing;
}

/**
 * After closing `closing`: whether the session view closes, and the tab in front. `keep` comes
 * to the front if the active tab closed; otherwise the closed active tab's neighbour (the next
 * one, else the previous one), as Paseo.
 */
export function planClose({ tabs, active, selected, closing, keep }: { tabs: TabRef[]; active: TabRef | null; selected: string | null; closing: TabRef[]; keep?: TabRef; }): { closingRoot: boolean; next: TabRef | null; } {
  const keys = new Set(closing.map(keyOf));
  const closingRoot = closing.some(tab => tab.kind === 'agent' && tab.id === selected);
  const left = new Set(tabs.filter(entry => !keys.has(keyOf(entry)) && !(closingRoot && entry.kind === 'agent')).map(keyOf));
  const closingActive = !!active && keys.has(keyOf(active));
  let next: TabRef | null = active && !closingActive ? active : null;
  if (active && closingActive) {
    if (keep && left.has(keyOf(keep))) next = keep;
    else {
      const index = tabs.findIndex(entry => keyOf(entry) === keyOf(active));
      next = tabs.slice(index + 1).find(entry => left.has(keyOf(entry))) ?? tabs.slice(0, index).reverse().find(entry => left.has(keyOf(entry))) ?? null;
    }
  } else if (next && !left.has(keyOf(next))) next = tabs.find(entry => left.has(keyOf(entry))) ?? null;
  return { closingRoot, next };
}
