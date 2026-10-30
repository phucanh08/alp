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
- `@anhlp/alp-client/integration-lock` (Node): `createIntegrationLock(home, name)`, the single-owner
  lock of one integration service at `<home>/integrations/<name>.lock`, serialized by the exclusive
  guard directory `<name>.lock.reclaim`. Each instance is single-use (`acquire`, then `setReady` and
  `release` while it owns the lock); its recovery rules are in
  [docs/modular-monorepo.md](../../docs/modular-monorepo.md).

Timeouts and aborts end only the caller's wait, and nothing is ever resent after a disconnect.
See [docs/alp/client-sdk.md](../../docs/alp/client-sdk.md) for the transport contract, the
request lifecycle, the old-to-new API table and what still waits on the protocol (Task 06) and
the gateway (Task 08).

`startIntegration({ name, entry, home, args })` (or `startIntegration(name)`; `name` defaults to `web`) discovers an optional integration's descriptor and starts it detached with `--service` and then `args`, so the entry writes its own log; discovery and the selected `ALP_HOME` are pinned by tests. `name` is a single lowercase path segment (`assertIntegrationName`). With `entry`, that script runs with the current Node and no descriptor, environment or PATH discovery happens; a missing entry is an error even when a live owner would be reused. `web` is alp-web, the service of the ALP CLI (`alp web`): it is never discovered, so it needs its `entry`, and `"web": { "enabled": false }` in the home's settings refuses it and no other integration. Everything once registered under `web` (`integrations/web.json`, the `alp-web-integration` binary, `ALP_WEB_INTEGRATION`) is the Paseo integration from before its rename; `discoverIntegration('paseo')` reads `ALP_PASEO_INTEGRATION`, then `ALP_WEB_INTEGRATION` for one release, then `ALP_INTEGRATION_ENTRY`. Errors name the integration, the entry and its log under `<home>/logs/integrations`. Either way a live owner of `integrations/<name>.lock` is reused, and the call resolves once that lock is ready and `<home>/<name>.json` names the same pid. Restarting is non-destructive: a daemon left running by an older install is reported as older than the current CLI and is never killed in place.

Build: `npm run build --workspace=@anhlp/alp-client`. Test: `npm run test --workspace=@anhlp/alp-client`.

Public imports use the package root and its explicitly exported subpaths. See [architecture, provider extension, compatibility and release instructions](../../docs/modular-monorepo.md).

`conversation(client)` from the portable entry wraps the conversation methods (capabilities
`session.fork`, `session.rewind`, `session.reload`, `session.resumeCommand` and
`session.configure.live`; docs/protocol/alp-json-rpc-v1.md §12.7–§12.9): `fork`, `rewind`, `reload`,
`resumeCommand`, `configure` and `configurePreview`. They change only the conversation, never a file.
Each mutation is sent once: keep its `requestId` and `ifGeneration` (the generation `session.history`
answered) and send the identical request again only after a lost answer, which alpd answers with the
first result and `duplicate: true`. After a rewind, attached clients get `history.reset`: drop the
cached history and attach again with its generation. See
[docs/alp/client-sdk.md](../../docs/alp/client-sdk.md).

Terminal directory clients can use `watchTerminals(connection, {capabilities, onSnapshot,
onMode, onError})` from the portable entry. Install one per connection, await `ready`, and call
`close()` when leaving. It uses atomic scoped snapshots and cursor invalidations on hosts with
`terminal.watch`; `onMode('polling')` explicitly identifies the five-second older-host fallback.
Reconnect with a new helper and replace the directory from the reset snapshot.
