// @ts-check
// A second node:test reporter the file watchdog adds beside the visible one (t-5294.2): one JSON line
// per subtest start and end, written as it happens, so a file that never finishes still tells which
// subtest is in flight and why the earlier ones failed. The spec reporter prints failure details only
// when the file ends, which a hung file never does. The watchdog reads this file only on a timeout.
const text = /** @param {unknown} value */ value => typeof value === 'string' ? value : value === undefined ? undefined : String(value);
const lines = /** @param {unknown} stack @param {number} count */ (stack, count) => typeof stack === 'string' ? stack.split('\n').slice(0, count).join('\n') : undefined;

/**
 * What a failed subtest's error says, compactly.
 * @param {{ failureType?: string, cause?: unknown } | undefined} error node:test's TestFailure
 */
function failure(error) {
  if (!error) return undefined;
  /** The error that failed the test (TestFailure wraps it as `cause`); any value may be thrown. @type {{ message?: unknown, code?: unknown, stack?: unknown } | undefined} */
  const cause = error.cause ?? error;
  return {
    failureType: error.failureType,
    message: text(cause?.message ?? cause),
    code: text(cause?.code),
    stack: lines(cause?.stack, 12),
  };
}

/** @param {AsyncIterable<import('node:test/reporters').TestEvent>} source */
export default async function* progress(source) {
  for await (const event of source) {
    const { type, data } = event;
    if (type !== 'test:dequeue' && type !== 'test:pass' && type !== 'test:fail') continue;
    /** @type {{ at: number, type: string, name: string, nesting: number, file?: string, line?: number, ms?: number, error?: ReturnType<typeof failure> }} */
    const entry = { at: Date.now(), type, name: data.name, nesting: data.nesting, file: data.file, line: data.line };
    if (type !== 'test:dequeue') entry.ms = data.details?.duration_ms;
    if (type === 'test:fail') entry.error = failure(data.details?.error);
    yield `${JSON.stringify(entry)}\n`;
  }
}
