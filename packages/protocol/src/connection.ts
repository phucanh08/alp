import type { Envelope } from './events.ts';
import type { AttachmentLimits, TerminalLimits } from './rpc.ts';

export type DaemonConnection = {
  // any: callers that pass no T get an untyped result to narrow themselves, as every adapter and caller
  // has relied on since this type existed; `unknown` here would be a breaking change to a public type.
  request<T = any>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (envelope: Envelope) => void): () => void;
  /** Notifications other than `event`, such as `terminal.event` (§12.10); absent on older adapters. */
  // any: the params shape depends on `method` (one listener receives every notification kind), and the
  // runtime transports implement this with the same signature; listeners narrow by method.
  onNotification?(listener: (method: string, params: any) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): void;
  /** True once the connection is gone; socket clients report it, in-process ones may not. */
  readonly closed?: boolean;
  /** Features captured by the Node client handshake; absent on older adapters. */
  readonly capabilities?: readonly string[];
  /** Limits captured by the Node client handshake; absent on older adapters. */
  readonly attachmentLimits?: AttachmentLimits;
  readonly promptImageLimits?: { readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number };
  readonly terminalLimits?: TerminalLimits;
};
