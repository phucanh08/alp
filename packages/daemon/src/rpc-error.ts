/** An error alpd answers with as is: its code, message and `data` (docs/protocol/alp-json-rpc-v1.md §5). */
export class RpcError extends Error {
  declare code: number;
  declare data?: unknown | undefined;
  constructor(code: number, message: string, data?: unknown | undefined) { super(message); this.code = code; this.data = data; }
}
