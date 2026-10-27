/** Subscribe before triggering the child; every wait has a total deadline and observes signal exit. */
export function childMessages(child, timeoutMs = 20_000) {
  const seen = [];
  const waiting = new Set();
  const wake = () => { for (const notify of waiting) notify(); };
  child.on('message', message => { seen.push(message); wake(); });
  child.on('exit', wake);
  async function message(event, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const finish = (error, found) => {
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
