# Modular ALP monorepo

ALP uses npm workspaces inspired by [Paseo's package layout](https://github.com/getpaseo/paseo/blob/main/package.json). The `@anhlp/alp` root package now uses the canonical workspace builds; root source shims and legacy checkout directories have been removed.

## Ownership and dependency rules

| Workspace | Public API | Owns | ALP dependencies |
|---|---|---|---|
| `@anhlp/alp-protocol` | version/constants/errors, JSON Schemas, event/session DTOs, connection contract | wire and data contracts | none |
| `@anhlp/alp-core` | named domain namespaces and exported domain subpaths | configuration, resolution, teams, tasks, hooks, permissions, templates | protocol |
| `@anhlp/alp-runtime` | `createAlpRuntime`, native transports, provider registry, runtime subpaths | sessions, delegation, mailbox, board, provider execution | core, protocol |
| `@anhlp/alp-client` | `AlpClient`, `connect`, discovery/lifecycle and helper subpaths | IPC client, supervision, service definitions, setup/diagnostics | core, protocol |
| `@anhlp/alp-daemon` | `createDaemonServer`, stores, web/Paseo bridge, shared panel RPCs | runtime hosting, persistence and server surfaces | runtime, core, client, protocol |
| `@anhlp/alp-cli` | `alp` executable; ACP subpaths | command domains and ACP editor adapter | client, core, protocol |
| `alp-paseo-plugin` | existing Paseo server/client entrypoints | Paseo host adapter and panels | daemon, runtime, client, core, protocol |
| `@anhlp/alp-tui` | none | reserved private workspace | none |

Cross-package code imports package exports, never sibling source paths. Public domain subpaths omit `.js`, for example `@anhlp/alp-core/tasks`. Imports inside a package remain relative. `npm run check:boundaries` checks source imports, declared dependencies, the allowed graph and cycles. Native SDKs stay in runtime or host adapters; core/protocol do not import them.

Canonical implementations live in `packages/*/src` and `packages/paseo`; the root package exposes built compatibility artifacts rather than source shims. Shared server-side panel RPC handlers belong to daemon; daemon does not depend on the plugin package.

The root `templates/` remains the editable source of truth. Build scripts copy it into the core package's generated `templates/` for standalone installation. Do not edit the generated copy. Existing template and data formats are unchanged.

## Build and test

```sh
npm ci
npm run check:boundaries
npm run check
npm test
npm run build:packages
npm run build --workspace=@anhlp/alp-runtime
npm run test --workspace=@anhlp/alp-runtime
```

Root `npm run build` retains the legacy bundle paths. Workspace builds compile the selected package and its dependencies, preserving individual module imports and emitting declarations. The `alp-source` export condition is only for repository builds/typechecking; published consumers use ordinary JavaScript and declaration exports.

Workspace tests reuse the existing hermetic regression suites with isolated ALP_HOME directories. `npm test` is the complete regression gate; `npm run test:packages` runs each package's assigned suite. Live `test:e2e:*` scripts are opt-in and require authenticated providers (and sometimes a running Paseo host).

Core, protocol, runtime and client can be compiled without a web build. Daemon/CLI compilation can also run without web assets. Packaging daemon, CLI, the compatibility root and the plugin requires the pinned web app:

```sh
npm run build:web
npm run build:packages
npm run release:pack-check
npm run test:packages:smoke
```

Prepack verifies the web artifact's pinned Paseo commit and patch inventory. The daemon and CLI distributions carry `alpd.js` and the web app; CLI also carries `acp.js`. The existing Claude SDK external dependency remains declared in each executable distribution.

## Independent versions and publishing

Versions are per manifest. Bump one package and update its dependency references/lockfile with:

```sh
npm run version:package -- @anhlp/alp-protocol 0.9.6
npm run build --workspace=@anhlp/alp-protocol
npm run test --workspace=@anhlp/alp-protocol
npm pack --workspace=@anhlp/alp-protocol --dry-run
npm publish --workspace=@anhlp/alp-protocol --access public
```

Publishing is an explicit operator action. Publish changed dependencies before dependents: protocol → core → runtime/client → daemon/CLI → plugin/compatibility root. The helper does not bump or publish unrelated package versions. TUI remains private and contains no implementation.

## Provider extension

The normalized request/notification/lifecycle interface is `RuntimeTransport`. Existing `RuntimeOptions.transport(cwd, env, kind, acp, antigravity)` remains the highest-priority injection hook. Each runtime can instead receive adapter overrides in `providers`, or an explicit `ProviderRegistry`:

```ts
import { createAlpRuntime, createProviderRegistry } from '@anhlp/alp-runtime';
const registry = createProviderRegistry();
registry.register('acp:my-agent', context => myTransport(context));
const runtime = createAlpRuntime({ providerRegistry: registry });
```

Codex, Claude, ACP and Antigravity factories retain existing command/environment precedence. Named ACP factories fall back to the generic ACP adapter. Provider normalization, sandbox configuration and native SDK specifics remain behind runtime adapters. No global registry is mutated.

## Protocol and future Rust modules

`packages/protocol/schema/ipc-v1.json` defines JSON-RPC frames and discriminated session events. `methods-v1.json` inventories built-in methods and parameter shapes. JSONL fixtures exercise handshake, success, error and event notification frames; tests compare method/event inventories with their implementations and validate emitted events.

The portable seam is JSON, not a TypeScript object or an in-process callback:

- Local sockets/named pipes carry UTF-8 newline-delimited JSON-RPC 2.0; event notifications use method `event`.
- Protocol version remains 1; the existing handshake, method names and error codes remain unchanged.
- Events retain opaque session ids, runtime epoch, per-session sequence and ISO timestamps. Replay cursors never cross epochs.
- Schemas accept additive fields, matching existing clients. Preserve JSON field names, nullability and persisted version-1 records when replacing implementations.
- Incompatible method/event semantics require a negotiated new protocol version. Package SemVer and wire protocol version are separate.
- The current frame guard is `MAX_FRAME` (16 × 1024 × 1024 decoded JavaScript string units); a Rust replacement must preserve that guard or negotiate a changed byte limit.

A Rust daemon can implement the same method/event contract and run the JSON fixtures plus client/daemon tests. An in-process Rust runtime replacement must preserve the exported `AlpRuntime` interface through a Node binding or package-owned proxy, including synchronous snapshot/list reads, event ordering and lifecycle behavior. Client, CLI and Paseo surfaces then continue over IPC. A Rust core would need an explicit serialized command boundary around current filesystem operations before replacing the in-process core API; this migration does not pretend TypeScript function calls are language-neutral IPC. No Rust implementation or TUI is introduced.

The Paseo plugin workspace lives in `packages/paseo` and retains the npm name `alp-paseo-plugin`. Build with `npm run build -w alp-paseo-plugin` and test with `npm run test -w alp-paseo-plugin`. Tool selectors accept `paseo`; the previous `paseo-plugin` selector remains an alias.
