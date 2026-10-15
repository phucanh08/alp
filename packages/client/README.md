# @anhlp/alp-client

The ALP RPC client: a portable JSON-RPC engine for Node, browsers and React Native, its
WebSocket and Node IPC transports, and the Node-only daemon discovery, supervision, services
and setup helpers.

- `@anhlp/alp-client/portable`: `AlpRpcClient`, errors, `hello`, `createReconnectingClient`,
  NDJSON framing. No Node built-ins, `process` or `Buffer`; needs no polyfills.
- `@anhlp/alp-client/websocket`: `connectWebSocket` over the browser's, React Native's or an
  injected WebSocket. Authentication is the caller's (the gateway's) business.
- `@anhlp/alp-client` (Node): everything above plus `connect`, `AlpClient`, `connectSocket`,
  `ensureDaemon`, the private-socket checks and lock helpers, unchanged for existing callers.
- `@anhlp/alp-client/ipc` (Node): `createSocketTransport` for a Unix socket or named pipe.

Timeouts and aborts end only the caller's wait, and nothing is ever resent after a disconnect.
See [docs/alp/client-sdk.md](../../docs/alp/client-sdk.md) for the transport contract, the
request lifecycle, the old-to-new API table and what still waits on the protocol (Task 06) and
the gateway (Task 08).

`startIntegration` discovers an optional integration's descriptor and starts it detached with `--service`, so the entry writes its own log; discovery and the selected `ALP_HOME` are pinned by tests. Restarting is non-destructive: a daemon left running by an older install is reported as older than the current CLI and is never killed in place.

Build: `npm run build --workspace=@anhlp/alp-client`. Test: `npm run test --workspace=@anhlp/alp-client`.

Public imports use the package root and its explicitly exported subpaths. See [architecture, provider extension, compatibility and release instructions](../../docs/modular-monorepo.md).
