import * as React from 'react';
import type { Controller, State } from '../lib/controller.js';

const ControllerContext = React.createContext<Controller | null>(null);

export function ControllerProvider({ controller, children }: { controller: Controller; children: React.ReactNode }) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function useController(): Controller {
  const controller = React.useContext(ControllerContext);
  if (!controller) throw new Error('useController outside ControllerProvider');
  return controller;
}

/** The controller's state; re-renders when it changes. */
export function useAppState(): State {
  const controller = useController();
  return React.useSyncExternalStore(
    React.useCallback(listener => controller.subscribe(listener), [controller]),
    () => controller.getState(),
  );
}

/** Runs an action, keeps its error for display, and reports whether it is running. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = React.useCallback(async (...args: A) => {
    setPending(true);
    setError(null);
    try { await action(...args); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setPending(false); }
  }, [action]);
  return { run, pending, error, clearError: () => setError(null) };
}
