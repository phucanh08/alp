# Paseo 0.12 catalog and local socket contract (t-095f)

This investigation is separate from provider discovery in
[paseo-app-boundary-012.md](paseo-app-boundary-012.md). Provider registration alone
says nothing about the app's plugin evaluator or HTTP upgrade headers.

## Catalog

[Upstream] Paseo 0.12.0, commit
[cafe4b01](https://github.com/getpaseo/paseo/tree/cafe4b01c8522ff39560241c5deb01427dc8dc5b):
`packages/server/src/server/plugins/runtime.ts` returns `{ id, clientBundle,
requirements }` from `catalog()`. `compiler.ts` wraps CommonJS client code in a
function accepting `require` and makes re-exports eager for Hermes.
`packages/app/src/plugins/registry.ts` passes the received string to
`runPluginClientBundle`; `evaluate.ts` evaluates it, requires a function, invokes
that factory with the host module resolver, and calls its default export.

[Local] The installed `@getpaseo/server@0.12.0` runtime/compiler and
`@getpaseo/client@0.12.0` catalog response types agree. The ALP bridge used to send
`alp-preloaded:alp-provider:<digest>`, understood only by the removed paseo-web
preloader. Evaluating that URI in the native contract fails with `Unexpected
token ':'`.

[Decision] Keep compiling and embedding ALP's client: native Paseo needs it too.
Return the actual factory as `clientBundle`. Keep requirements, panel RPC handlers,
and the empty user-managed plugin list. Do not remove plugin catalog or RPC support.
There is no HTTP bundle endpoint. The normal plugin installed in a Paseo daemon
continues to use Paseo's own compiler/catalog, independently of this bridge.

## Local /ws

[Upstream] At the same commit, `packages/app/src/runtime/host-runtime.ts` selects
`createAppWebSocketFactory()` for `directTcp`; `runtime/websocket-factory.ts`
selects `nativeWebSocketFactory` from the client SDK. The installed SDK's
`daemon-client-websocket-transport.js` constructs the native WebSocket with
`{ headers: options?.headers }`; it does not synthesize a browser Origin. The SDK's
default factory likewise calls the global WebSocket without adding Origin.
Desktop socket/pipe/SSH and encrypted relay paths are distinct transports.

[Local] Baseline 7fa35c1 required the listener's former page Origin, accepting a
same-origin browser and rejecting an Origin-less native/local WebSocket. This
contradicted the task's initial description of the existing rule.

[Decision] Accept an upgrade only when Origin is absent. Refuse every supplied
Origin, including empty, `null`, same-listener and foreign origins. Preserve the
loopback listener, strict Host/port check, `/ws` path, frame limit, and token/hello
authentication. An absent Origin is not authentication; a native client can set
headers, and the gateway must still check its token. No browser client needs to
use this listener after paseo-web removal; ALP's browser uses its own gateway.

## Proof and limits

The bridge catalog regression evaluates the returned factory string as native
Paseo does, then exercises panel RPCs. The socket regression covers absent Origin
acceptance, supplied Origin refusals and invalid Host refusal. Existing bridge
checks retain missing/wrong-token and protocol rejection coverage.

Both regressions failed on the baseline and passed after correction. These checks
exercise real loopback upgrades and schema-validated bridge frames with fixture
agents. They do not claim that a live Paseo.app UI rendered the panels; that manual
native-host check was not run. Browser SDK smoke uses a separate test-only bridge.
