// web.pairing is the user's (t-d08b): alpd stamps extension.invoke with `caller` from the calling
// connection. Without it, alpd is older than this integration and cannot vouch for the caller.
export function assertPairingCaller(params: any): void {
  const caller = params?.caller;
  if (caller === undefined || caller === null || typeof caller.agent !== 'boolean') {
    throw Object.assign(new Error('alpd did not say who is calling web.pairing; restart alpd'), { code: 1003, data: { reason: 'user_only' } });
  }
  if (caller.agent !== false) {
    throw Object.assign(new Error("web.pairing is the user's; this connection was opened by an ALP agent"), { code: 1003, data: { reason: 'user_only' } });
  }
}

/** alpd refused extension.register because this process's connection is agent-marked: retrying cannot help. */
export function isUserOnlyRefusal(error: any): boolean {
  return error?.data?.reason === 'user_only';
}

export const USER_ONLY_REGISTER_HINT = 'web.pairing not registered: alpd refused extension.register as user-only; this process runs under an ALP agent (ALP_AGENT_SESSION set); unset it and restart';
