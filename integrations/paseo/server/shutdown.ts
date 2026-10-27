/** One shutdown owner and one total deadline, including the lock release itself. */
export function createShutdown({ steps, exit, report, timeoutMs = 25_000 }: {
  steps: Array<{ name: string; run: () => unknown }>;
  exit: (code: number) => void;
  report: (stage: string, error?: unknown) => void;
  timeoutMs?: number;
}) {
  let running: Promise<void> | undefined;
  let status = 0;
  return (code = 0): Promise<void> => {
    status = Math.max(status, code);
    if (running) return running;
    running = (async () => {
      let stage = 'shutdown';
      // Keep this referenced: even a stuck promise with no live handles must reach the deadline.
      const watchdog = setTimeout(() => {
        // Never force-remove a lock when cleanup or ownership verification is incomplete.
        try { report(stage); } finally { exit(1); }
      }, timeoutMs);
      try {
        for (const step of steps) {
          stage = step.name;
          try { await step.run(); }
          catch (error) { status = 1; report(stage, error); }
        }
      } finally {
        clearTimeout(watchdog);
        exit(status);
      }
    })();
    return running;
  };
}
