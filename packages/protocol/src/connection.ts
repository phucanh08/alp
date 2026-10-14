import type { Envelope } from './events.js';
export type DaemonConnection = {
  request<T = any>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (envelope: Envelope) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): void;
  /** True once the connection is gone; socket clients report it, in-process ones may not. */
  readonly closed?: boolean;
};
