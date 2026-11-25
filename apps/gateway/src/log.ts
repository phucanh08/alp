import { createLogger } from '@anhlp/alp-core/log';
import type { LogLevel, Logger } from '@anhlp/alp-core/log';

/**
 * The gateway's structured log: ALP's redacted JSON lines (@anhlp/alp-core/log) with one more
 * pass for the gateway's own secrets, whose shapes the shared patterns do not know. Fields are
 * named so the shared redaction keeps them (`principal`, not `credentialId`), and no code path
 * passes a token, a ticket or a subprotocol list to the logger; the scrub is the backstop.
 */

/** Gateway tokens (`alpgw1.<id>.<secret>`), tickets (`alpgwt.<secret>`) and the ticket subprotocol. */
const SECRETS: [RegExp, string][] = [
  [/\balpgw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'alpgw1.[redacted]'],
  [/\balpgwt\.[A-Za-z0-9_-]+/g, 'alpgwt.[redacted]'],
  [/\balp\.ticket\.[A-Za-z0-9._-]+/g, 'alp.ticket.[redacted]'],
];

/** `line` without any gateway credential. */
export function scrubGatewaySecrets(line: string) {
  let result = line;
  for (const [pattern, replacement] of SECRETS) result = result.replace(pattern, replacement);
  return result;
}

export function createGatewayLogger({ write, level, env }: { write?: (line: string) => void, level?: LogLevel, env?: Record<string, string | undefined> } = {}): Logger {
  const sink = write ?? ((line: string) => { try { process.stderr.write(`${line}\n`); } catch {} });
  return createLogger({ component: 'alp-gateway', level, env, write: line => sink(scrubGatewaySecrets(line)) });
}
