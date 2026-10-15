import { open, stat } from 'node:fs/promises';

/**
 * Structured, redacted logging for ALP processes. One JSON object per line, written to stderr
 * unless a sink is given: stdout belongs to command output, `--json` and the ACP stream, so a
 * log line never lands there. A record has `time`, `level`, `component`, an optional error
 * `code`, `msg`, correlation ids (`sessionId`, `rootId`, `assignmentId`, `clientMessageId`,
 * `requestId`, `agent`) and a few extra fields. Logging never throws.
 *
 * Nothing sensitive is logged by default: keys that carry prompts, environments or credentials
 * are replaced, secret-looking values and the values of secret-named environment variables are
 * scrubbed from every string, and long strings are cut.
 */

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
export const REDACTED = '[redacted]';
export const OMITTED = '[omitted]';
const MAX_STRING = 2000;
const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ITEMS = 20;
const STACK_LINES = 8;

/** Fields that hold a credential: the value is replaced. */
const SECRET_KEY = /pass(word|wd)?|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key|bearer|signature/i;
/** Fields that hold user content or the process environment: never logged, not even scrubbed. */
const OMITTED_KEY = /^(env|environment|prompt|prompts|instructions|content|text|input|headers|body|args|argv)$/i;
/** Environment variable names whose values are secrets, to find them inside any text. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE/i;

const PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // NAME=value and NAME: value for names that look like secrets; also JSON "token": "value".
  [/(\b[\w.-]*(?:key|token|secret|passw(?:or)?d|credential|authorization|cookie)[\w.-]*["']?\s*[=:]\s*)(?:"[^"]{4,}"|'[^']{4,}'|[^\s,;&"']{8,})/gi, `$1${REDACTED}`],
  // --token value, --api-key value
  [/(--[\w-]*(?:key|token|secret|passw(?:or)?d|credential)[\w-]*\s+)[^\s-][^\s]*/gi, `$1${REDACTED}`],
];

/** Values of secret-named variables in `env`, long enough that replacing them is not noise. */
function secretValues(env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env ?? {})) if (typeof value === 'string' && value.length >= 8 && SECRET_NAME.test(name)) values.add(value);
  return [...values].sort((a, b) => b.length - a.length);
}

/** `text` without anything that looks like a credential, cut to `max` characters. */
export function scrubText(text, { env = process.env, max = MAX_STRING } = {}) {
  let result = String(text);
  for (const value of secretValues(env)) result = result.split(value).join(REDACTED);
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result.length > max ? `${result.slice(0, max)}... (${result.length - max} more characters)` : result;
}

/** An error as a plain, scrubbed object: name, code, message and the top of its stack. */
export function describeError(error, options = {}) {
  if (!(error instanceof Error)) return { message: scrubText(error, options) };
  const stack = typeof error.stack === 'string' ? error.stack.split('\n').slice(0, STACK_LINES).join('\n') : undefined;
  return {
    name: error.name,
    ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: error.code } : {}),
    message: scrubText(error.message, options),
    ...(stack ? { stack: scrubText(stack, options) } : {}),
    ...(error.cause !== undefined ? { cause: describeError(error.cause, options) } : {}),
  };
}

/** A copy of `value` that is safe to write to a log: see the module comment. */
export function redact(value, options = {}, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return scrubText(value, options);
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (value instanceof Error) return describeError(value, options);
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(item => redact(item, options, depth + 1, seen));
    return value.length > MAX_ITEMS ? [...items, `... ${value.length - MAX_ITEMS} more`] : items;
  }
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    result[key] = OMITTED_KEY.test(key) ? OMITTED : SECRET_KEY.test(key) ? REDACTED : redact(item, options, depth + 1, seen);
  }
  return result;
}

/** Fields every record may carry to tie its lines to a session, assignment or request. */
const CORRELATION = ['sessionId', 'rootId', 'assignmentId', 'clientMessageId', 'requestId', 'agent'];

const stderrSink = line => { try { process.stderr.write(`${line}\n`); } catch {} };

/**
 * A logger for `component` (`alpd`, `store`, `runtime`, `acp`, ...). `level` defaults to
 * ALP_LOG_LEVEL, then `info`. `context` ids are added to every record. `write` receives one
 * serialized line without its newline.
 */
export function createLogger({ component, level, context = {}, write = stderrSink, now = () => new Date(), env = process.env } = {}) {
  const threshold = LEVELS[level ?? env.ALP_LOG_LEVEL] ?? LEVELS.info;
  const options = { env };
  const emit = (name, message, fields = {}) => {
    if (LEVELS[name] < threshold) return;
    try {
      const { code, error, ...rest } = { ...context, ...fields };
      const record = {
        time: now().toISOString(), level: name, component, ...(code ? { code: String(code) } : {}), msg: scrubText(message, options),
      };
      for (const key of CORRELATION) if (rest[key] !== undefined) record[key] = redact(String(rest[key]), options);
      if (error !== undefined) {
        record.error = describeError(error, options);
        // An error's own code names the failure when the caller gave none.
        if (!record.code && record.error.code !== undefined) record.code = String(record.error.code);
      }
      for (const [key, value] of Object.entries(rest)) {
        if (CORRELATION.includes(key)) continue;
        record[key] = OMITTED_KEY.test(key) ? OMITTED : SECRET_KEY.test(key) ? REDACTED : redact(value, options);
      }
      write(JSON.stringify(record));
    } catch {}
  };
  return {
    component,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra = {}, name = component) => createLogger({ component: name, level, context: { ...context, ...extra }, write, now, env }),
  };
}

const TAIL_BYTES = 256 * 1024;

/**
 * The records at the end of a log file, oldest first. Lines that are not ALP records (output
 * from before structured logging, a runtime's own stderr) are returned as `{ legacy: text }`
 * with the text scrubbed. A file that is missing gives an empty list.
 */
export async function readLogTail(file, { bytes = TAIL_BYTES, env = process.env } = {}) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await stat(file);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // The first line of a tail may be cut.
    if (start > 0) lines.shift();
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object' && typeof record.time === 'string' && typeof record.level === 'string' && typeof record.msg === 'string') {
          records.push(redact(record, { env }));
          continue;
        }
      } catch {}
      records.push({ legacy: scrubText(line, { env, max: 500 }) });
    }
    return records;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  } finally {
    await handle?.close();
  }
}
