export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LEVELS: Readonly<Record<LogLevel, number>>;
export const REDACTED: string;
export const OMITTED: string;
export type LogFields = {
  code?: string;
  error?: unknown;
  sessionId?: string;
  rootId?: string;
  assignmentId?: string;
  clientMessageId?: string;
  requestId?: string;
  agent?: string;
  [key: string]: unknown;
};
export type LogRecord = {
  time: string;
  level: LogLevel;
  component: string;
  code?: string;
  msg: string;
  error?: { name?: string; code?: string | number; message: string; stack?: string; cause?: unknown };
  [key: string]: unknown;
};
export type Logger = {
  component: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(extra?: LogFields, component?: string): Logger;
};
export function scrubText(text: unknown, options?: { env?: Record<string, string | undefined>; max?: number }): string;
export function describeError(error: unknown, options?: { env?: Record<string, string | undefined> }): { name?: string; code?: string | number; message: string; stack?: string; cause?: unknown };
export function redact(value: unknown, options?: { env?: Record<string, string | undefined> }): any;
export function createLogger(options: { component: string; level?: LogLevel; context?: LogFields; write?: (line: string) => void; now?: () => Date; env?: Record<string, string | undefined> }): Logger;
export function readLogTail(file: string, options?: { bytes?: number; env?: Record<string, string | undefined> }): Promise<Array<LogRecord | { legacy: string }>>;
