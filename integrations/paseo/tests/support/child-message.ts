import type { ChildProcess } from 'node:child_process';

// `any`: the child's IPC messages are JSON of every shape; the tests read their fields.
type Json = any;

/** Subscribe before triggering the child; every wait has a total deadline and observes signal exit. */
export function childMessages(child: ChildProcess, timeoutMs = 20_000) {
  const seen: Json[] = [];
  const waiting = new Set<() => void>();
  const wake = () => { for (const notify of waiting) notify(); };
  child.on('message', (message: Json) => { seen.push(message); wake(); });
  child.on('exit', wake);
  async function message(event: string, predicate: (message: Json) => boolean = () => true) {
    return new Promise<Json>((resolve, reject) => {
      const finish = (error: Error | null, found?: Json) => {
        clearTimeout(timer);
        waiting.delete(check);
        if (error) reject(error); else resolve(found);
      };
      const check = () => {
        const found = seen.find(m => m.event === event && predicate(m));
        if (found) finish(null, found);
        else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`exited before ${event} (${child.exitCode ?? child.signalCode})`));
      };
      const timer = setTimeout(() => finish(new Error(`no ${event}; saw ${JSON.stringify(seen)}`)), timeoutMs);
      waiting.add(check);
      check();
    });
  }
  return { seen, message };
}
