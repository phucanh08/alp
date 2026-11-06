// The one teardown shape for every test in this repository (t-5294.2, t-5294.6).
//
// node:test runs the `t.after` hooks of a test in the order they were registered and STOPS at the
// first one that throws. A test that registered `rm(directory)` first and `server.close()` second
// therefore skipped the close whenever the rm threw — and ENOTEMPTY is routine, because a write the
// test never awaited (a cache flush, a scaffolded project) can still be landing in that directory.
// The visible result was a file that failed one subtest, passed the rest, and then sat on its open
// sockets until the 300 s per-file watchdog killed it. That hung CI three times on 2026-11-06
// (core-paseo-macos jobs 127622779702/127628147149, windows-daemon 22/24).
//
// `teardown(t)` registers ONE hook and gives back `defer`. Register each step right after the setup
// it undoes, in setup order, and this hook:
//
//   1. runs them in REVERSE order, so a resource is released before the directory it lives in goes,
//   2. runs EVERY step even when an earlier one throws, so one bad rm cannot leak a process, and
//   3. still fails the test, with the first error (an AggregateError when several steps threw).
//
//     const defer = teardown(t);
//     const directory = await mkdtemp(...);
//     defer(() => rm(directory, { recursive: true, force: true }));   // undone last
//     const server = await listen();
//     defer(() => server.close());                                    // undone first
//
// Calling `teardown(t)` again for the same `t` returns the same `defer`, so a fixture helper and the
// test body that calls it share one ordered list. Prefer this over a bare `t.after` that removes a
// directory: scripts/check-teardown-order.mjs fails the build on a new one.

/** @type {WeakMap<object, (step: () => unknown) => void>} */
const handles = new WeakMap();

/**
 * One reverse-order teardown hook for `t` (a node:test TestContext, or `test` itself for a
 * file-level hook). Returns `defer(step)`; see the note above.
 * @param {{ after: (fn: () => unknown) => unknown }} t
 * @returns {(step: () => unknown) => void}
 */
export function teardown(t) {
  const existing = handles.get(t);
  if (existing) return existing;
  /** @type {Array<() => unknown>} */
  const steps = [];
  t.after(async () => {
    const errors = [];
    // Pop rather than iterate a reversed copy: a step that defers another step (a cleanup that
    // opens something) is still run, and no step can run twice.
    while (steps.length) {
      try { await steps.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    // Name every failure in the message itself: Node 22's reporter prints an AggregateError's
    // message but not its .errors, so otherwise only the newer reporters show which steps failed.
    if (errors.length) {
      const messages = errors.map(error => (error instanceof Error ? error.message : String(error)));
      throw new AggregateError(errors, `teardown failed: ${messages.join('; ')}`);
    }
  });
  const defer = step => { steps.push(step); };
  handles.set(t, defer);
  return defer;
}
