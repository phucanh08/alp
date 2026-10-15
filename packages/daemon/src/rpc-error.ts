/** An error alpd answers with as is: its code, message and `data` (docs/protocol/alp-json-rpc-v1.md §5). */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}
