import * as React from 'react';
import { USAGE_PREFS_KEY, loadUsagePrefs, updateUsagePrefs, type UsagePrefs } from '../../../lib/usage-prefs.js';

/*
 * The browser's usage preferences (lib/usage-prefs.js) as one live value: Settings › Usage and the
 * sidebar summary read the same one, so a change on the page shows in the footer at once, and a
 * change in another tab arrives through the storage event.
 */

const storage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
const listeners = new Set<() => void>();
let current: UsagePrefs | null = null;

const read = () => (current ??= loadUsagePrefs(storage()));
const notify = () => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  const fromOtherTab = (event: StorageEvent) => { if (event.key === USAGE_PREFS_KEY) { current = null; notify(); } };
  globalThis.addEventListener?.('storage', fromOtherTab);
  return () => { listeners.delete(listener); globalThis.removeEventListener?.('storage', fromOtherTab); };
}

/** Changes the preferences; kept for this page even when storage refuses (a private window). */
export function changeUsagePrefs(change: (prefs: UsagePrefs) => UsagePrefs) {
  current = updateUsagePrefs(storage(), change) ?? change(read());
  notify();
}

export function useUsagePrefs(): UsagePrefs {
  return React.useSyncExternalStore(subscribe, read, read);
}
