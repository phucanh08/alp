import type { Envelope } from './events.js';
export type DaemonConnection = {
  request<T = any>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (envelope: Envelope) => void): () => void;
  /** Notifications other than `event`, such as `terminal.event` (§12.10); absent on older adapters. */
  onNotification?(listener: (method: string, params: any) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): void;
  /** True once the connection is gone; socket clients report it, in-process ones may not. */
  readonly closed?: boolean;
  /** Features captured by the Node client handshake; absent on older adapters. */
  readonly capabilities?: readonly string[];
};
