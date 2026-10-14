/** Portable JSON-RPC structures; implementations and provider SDKs stay outside protocol. */
export type RpcId = string | number | null;
export type RpcErrorData = { code: number; message: string; data?: unknown };
export type RpcRequest = { jsonrpc: '2.0'; id?: RpcId; method: string; params?: Record<string, unknown> };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId } & ({ result: unknown; error?: never } | { error: RpcErrorData; result?: never });
export type EventNotification = { jsonrpc: '2.0'; method: 'event'; params: import('./events.js').Envelope };
