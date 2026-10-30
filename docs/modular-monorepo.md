# Modular ALP monorepo

ALP uses npm workspaces inspired by [Paseo's package layout](https://github.com/getpaseo/paseo/blob/main/package.json). The `@anhlp/alp` root package now uses the canonical workspace builds; root source shims and legacy checkout directories have been removed.

## Repository layout

```text
packages/       ALP libraries and executables, published as @anhlp/alp-*
  protocol  core  runtime  client  daemon  cli
integrations/   optional adapters to external hosts, each a separate package
  paseo/        @anhlp/alp-paseo (Paseo plugin, web app, relay)
  paseo.json    development-only descriptor; not shipped in core
apps/           standalone applications
  tui/          @anhlp/alp-tui (reserved, private)
```

Workspaces are `packages/*` (the six libraries), `integrations/paseo` and `apps/tui`; package names, versions and public exports did not change with the move. Dependencies run one way: `packages/*` never depend on `integrations/*` or `apps/*`, and nothing depends on an integration or an app. `npm run check:boundaries` fails on any such edge, on dependencies outside the allowed graph, and on cycles. Update path-based tooling through `scripts/test-lib.mjs` (`workspaceDirectory`) and `scripts/build-workspace.mjs` (`locations`).

The plugin depends on the daemon only for its embedded mode and for the `alpd` it bundles; every other interaction goes through `@anhlp/alp-client` and `@anhlp/alp-protocol` over IPC. The daemon, runtime, core, client and cli packages do not import it.

## Ownership and dependency rules

| Workspace | Public API | Owns | ALP dependencies |
|---|---|---|---|
| `@anhlp/alp-protocol` | version/constants/errors, JSON Schemas, event/session DTOs, connection contract | wire and data contracts | none |
| `@anhlp/alp-core` | named domain namespaces and exported domain subpaths | configuration, resolution, teams, tasks, hooks, permissions, templates | protocol |
| `@anhlp/alp-runtime` | `createAlpRuntime`, native transports, provider registry, runtime subpaths | sessions, delegation, mailbox, board, provider execution | core, protocol |
| `@anhlp/alp-client` | `AlpClient`, `connect`, discovery/lifecycle and helper subpaths | IPC client, supervision, service definitions, setup/diagnostics | core, protocol |
| `@anhlp/alp-daemon` | `createDaemonServer`, stores, neutral IPC extensions | runtime hosting, persistence and server surfaces | runtime, core, client, protocol |
| `@anhlp/alp-cli` | `alp` executable; ACP subpaths | command domains and ACP editor adapter | client, core, protocol |
| `@anhlp/alp-paseo` | existing Paseo server/client entrypoints | Paseo host adapter and panels | daemon, runtime, client, core, protocol |
| `@anhlp/alp-tui` | none | reserved private workspace | none |

Cross-package code imports package exports, never sibling source paths. Public domain subpaths omit `.js`, for example `@anhlp/alp-core/tasks`. Imports inside a package remain relative. `npm run check:boundaries` checks source imports, declared dependencies, the allowed graph and cycles. Native SDKs stay in runtime or host adapters; core/protocol do not import them.

Canonical implementations live in `packages/*/src`, `integrations/paseo` and `apps/tui`; the root package exposes built compatibility artifacts rather than source shims. Shared server-side panel RPC handlers belong to the plugin; the daemon hosts only neutral IPC extensions and does not depend on the plugin package.

The root `templates/` remains the editable source of truth. Build scripts copy it into the core package's generated `templates/` for standalone installation. Do not edit the generated copy. Existing template and data formats are unchanged.

## Build and test

`npm run validate` is the shared local/CI baseline. Run `validate:core`,
`validate:paseo`, or `validate:packages` separately to isolate failures. See
[CI baseline](ci-baseline.md) for build ordering, requirements and recorded results.

```sh
npm ci
npm run check:boundaries
npm run check
npm test
npm run build:packages
npm run build --workspace=@anhlp/alp-runtime
npm run test --workspace=@anhlp/alp-runtime
```

Root `npm run build` retains the neutral legacy bundle paths and builds the CLI without Paseo. `npm run build:paseo` builds the optional plugin. Workspace builds compile the selected package and its dependencies, preserving individual module imports and emitting declarations. The `alp-source` export condition is only for repository builds/typechecking; published consumers use ordinary JavaScript and declaration exports. The Paseo plugin `@anhlp/alp-paseo` is the exception: it ships no declarations, since Paseo installs an `npm:` plugin without its peers and resolves every type import ([#111](https://github.com/phucanh08/alp/issues/111)).

## Test layout

Tests follow package ownership. A test that imports only one package and the packages it declares as dependencies lives in `<workspace>/tests/` (`packages/<name>`, or `integrations/paseo` for the plugin) and runs with that package's `npm test`, which builds the package and its dependencies first. A test that crosses packages (several runtimes through the CLI, a daemon with a client and the plugin, repository-wide checks) lives in `test/integration/`. Live-provider scripts live in `test/e2e/`. Shared fixture transports stay in `test/support/`; they are plain files, not a package, and package tests may import them (and only them) from outside the package.

| Package | Tests |
| --- | --- |
| protocol | wire contract: fixtures, schema, method and event inventories |
| core | adapter, delegation, IR validation, library editing, resolver, upgrade |
| runtime | sessions, context, hardening, limits, pause, recall, supervisor, verdicts, worktrees, providers, v1 events |
| client | prompt, golden output, daemon endpoints |
| daemon | daemon lifecycle, board, extensions RPC, recovery, settings, usage, method inventory |
| cli | init, library, default providers, doctor, web pairing |
| @anhlp/alp-paseo | plugin bridge, panel, settings screen, web, relay, providers, skills, workflow, supervise, integration process logs |
| `test/integration` | ACP, Antigravity, beads, epics, hooks, language, permissions, service, setup, tasks, teams, template sync, verify, library tools, distribution layout, boundaries, web process and discovery, test layout |

Commands, from the repository root:

```sh
npm test                    # unit + integration, hermetic, each file once
npm run test:unit           # every packages/*/tests
npm run test:integration    # test/integration
npm run test:e2e            # test/e2e, live providers (opt-in)
npm run test:all            # all of the above
npm test -w @anhlp/alp-core # one package, independently
```

Every run uses an isolated `ALP_HOME`. `npm run test:packages` runs each package's own `npm test` in turn; it overlaps with `test:unit` and is meant for checking that a package tests on its own. Live `test:e2e:*` scripts require authenticated providers (and sometimes a running Paseo host). `test/integration/layout.test.js` fails when a test file sits outside these directories, is selected twice, or names a package its own package does not depend on.

Every core workspace — protocol, core, runtime, client, daemon and CLI — compiles and tests without a web build; `scripts/build-core.mjs` emits the neutral core bundles and the six core packages' tests never build the plugin. Packing needs only the packages' own builds:

```sh
npm run build:packages
npm run release:pack-check
npm run test:packages:smoke
```

Plugin prepack builds the plugin; core prepack runs only the core build. The daemon distribution carries `alpd.js`; the CLI carries `alpd.js`, `acp.js` and `alp web`'s service with ALP's own app (`dist/alp-web.js`, `dist/alp-web/`); the plugin ships the bridge and the integration entry (`server/dist/main.js`) with Paseo's licence (`LICENSE.paseo.txt`), and no web app since Paseo's web app (`paseo-web/`) was removed (t-55ce.3); the root `@anhlp/alp` distribution ships only core artifacts. The existing Claude SDK external dependency remains declared in the executable distributions.

### Breaking migration: the daemon no longer serves the web app

The web/Paseo surface moved out of the neutral daemon into the optional plugin. Consumers that reached the web app through `@anhlp/alp-daemon` must move to the plugin package:

| Removed | Replacement |
| --- | --- |
| `@anhlp/alp-daemon/web` (`createWebServer`, `createPaseoBridge`, `webAppDir`, `webFile`, `DEFAULT_WEB_PORT`) | `@anhlp/alp-paseo/web` (the same named exports, except `webAppDir`, removed with Paseo's web app in t-55ce.3; `createWebServer` takes `gateway`, and its `app` option is deprecated) |

`@anhlp/alp-daemon` keeps only its `index`, `lock`, `main`, `server` and `store` subpaths; the `web` export and `src/web.ts` are gone, so an `alp-daemon/web` import now fails at resolution. The daemon's neutral core bundles (`dist/runtime/index.js`, `dist/daemon/index.js`, `dist/alpd.js`, `dist/acp.js`, `dist/acp/agent.js`) never include the plugin or `@getpaseo`; `npm run check:boundaries` reads `dist/build-manifest.json` to prove it. The plugin's own subpaths (`@anhlp/alp-paseo`, `/main`, `/web`, `/paseo/*`, `/panel/*`) replace the old in-daemon copies, and Paseo's installed integration can register its descriptor at `$ALP_HOME/integrations/paseo.json` using `alp-paseo-integration --register` (`alp-web-integration` is an alias for one release).

Migrate an in-repo consumer in two steps:

```sh
# 1. Install the optional integration beside the CLI.
npm install -g @anhlp/alp-paseo@beta
# 2. Move the import to the plugin and restart the daemon so it picks up the new build.
#    -import { createWebServer } from '@anhlp/alp-daemon/web';
#    +import { createWebServer } from '@anhlp/alp-paseo/web';
alp daemon restart
```

#### Dependency inventory

The six core workspaces depend only on `@anhlp/*` packages and their own declared SDKs; none declares or imports `@getpaseo/*`. The plugin is an optional consumer and declares Paseo as peer dependencies:

| Package | Declares `@getpaseo/*` | Provides |
| --- | --- | --- |
| `@anhlp/alp-protocol` … `@anhlp/alp-cli` | no | the neutral core |
| `@anhlp/alp-paseo` | peers `@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`, `@getpaseo/relay` (and React) | the Paseo host adapter, the bridge and relay, and the panels |

`npm run release:pack-check` packs the main distribution and each public workspace, rejects Paseo paths in core tarballs and verifies public exports; `npm run release:tarball-check` then installs the tarballs in isolation — the core set with no `@getpaseo`, plugin or React package must import and typecheck, and the plugin must install with its declared peers.

#### Neutral extensions and the plugin's process data

The daemon hosts *neutral* IPC extensions: a connection registers a method with `extension.register`, owns it until it disconnects or calls `extension.unregister`, and the daemon routes `extension.invoke` calls back to the owner (bounded pending calls, torn down on disconnect). The daemon assigns no meaning to a method. The plugin registers `web.pairing` on its alpd connection and re-registers it after a daemon restart; `alp web pair` waits for the fresh registration instead of failing on an unknown method.

The plugin's per-process data stays under the selected home, never inside the daemon: the integration is named `paseo`: its lock is `<home>/integrations/paseo.lock`, the ready address is `<home>/paseo.json`, the registered descriptor is `<home>/integrations/paseo.json`, and the log is `<home>/logs/integrations/paseo.log`. `alp web pair` reads the lock and `paseo.json` and ignores a stale file named by another pid. `alp web` itself runs the CLI's `alp-web` service, which owns `integrations/web.lock` and `<home>/web.json` ([docs/alp/web.md](alp/web.md) §3.1). Set `ALP_HOME` to keep everything in one directory.

The Paseo integration serializes every lock mutation with the exclusive directory `<home>/integrations/paseo.lock.reclaim`. The protocol is `createIntegrationLock(home, name)` from `@anhlp/alp-client/integration-lock`; an integration named `<name>` uses `integrations/<name>.lock` and `integrations/<name>.lock.reclaim` with the same rules (the Paseo integration uses `paseo`; `alp-web` uses `web`). It never reaps this guard by age or PID. A stalled initializer/reclaimer retains exclusion; a crash during even a short guarded operation can require manual recovery. A complete recognized lock is automatically recovered only when its positive PID is absent (`ESRCH`) in the same boot context. Live PIDs (including reused PIDs), permission errors, unknown liveness errors, boot uncertainty, malformed locks and unsupported metadata never authorize takeover. Ready updates and release check the acquired lifetime nonce and file identity.

This guarantee requires a private local filesystem on one host in the same PID namespace, with **all integration writers using this protocol**. Stop all old integration processes before upgrading; the directory guard alone does not make competing old/new writers safe. Network/shared homes, live manual lock deletion/replacement and storage power-loss durability are outside the guarantee. After a stranded guard or malformed lock, first stop and wait for **ALL integration processes using that ALP_HOME**. Only then remove that integration's `integrations/<name>.lock` and `integrations/<name>.lock.reclaim` (including its guard token), and restart. Retain the web configuration, daemon state and separate `state/paseo-create/writer.lock`/receipt journal; this recovery procedure does not authorize changing them.

#### Restart and upgrade

Restarting is non-destructive. `alp daemon restart` (or the plugin's supervision) starts a fresh daemon; the plugin reconnects and re-registers its extensions, and sessions resume from their threads at the next prompt. A daemon left running by an older install is never killed or migrated in place: run `alp daemon restart` to move to the new build, so a restart to migrate is always explicit.

## Independent versions and publishing

> **For the beta `0.0.1-beta.5`, do not use the commands in this section.** The beta gives all
> eight published packages one version, packs them once and publishes those tarballs with
> `--tag beta`, following the manual checklist in [beta-scope.md](alp/beta-scope.md) §7. The
> `npm publish` below has no `--tag`, so it would set `latest`.

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

The Paseo plugin workspace lives in `integrations/paseo` and uses the npm name `@anhlp/alp-paseo`. Build with `npm run build -w @anhlp/alp-paseo` and test with `npm run test -w @anhlp/alp-paseo`. Tool selectors accept `paseo`; the previous `paseo-plugin` selector remains an alias.

## Paseo isolation

The ALP core six workspaces (`protocol`, `core`, `runtime`, `client`, `daemon`, `cli`) now contain no `@getpaseo/*` imports or dependencies. Paseo-specific protocol handling, panel RPC implementations, shared RPC mapping, and the `createPaseoBridge` web/relay gateway moved to `integrations/paseo`; daemon artifacts expose them no longer. The Paseo integration remains an optional consumer of ALP daemon IPC and may be shipped separately or bundled as an optional executable/app. `check-boundaries` additionally validates packed `dist` artifacts for leaked Paseo dependencies.

### Main distribution and standalone proof

`@anhlp/alp` has no required, optional, peer or bundled `@getpaseo/*` dependency,
and ships neither the web app nor integration descriptors/server artifacts.
The root build/prepack and all six workspace builds are core-only. Declaration
emission uses `packages/daemon/src/alp-templates.d.ts`, with no Paseo source input.

`npm run test:core:standalone` copies only the six core sources, templates and
build scripts into a temporary source tree, installs build dependencies there,
and runs actual npm prepack lifecycles without `integrations/paseo` or a web
build. It installs the resulting six tarballs in one consumer and `@anhlp/alp`
with only its declared ALP dependencies in another. Both run CLI/daemon/IPC and
ACP stdio handshake, prompt and streamed response with a fake provider. Installed
artifacts and the complete npm dependency tree are checked for Paseo leakage.
The existing runtime/reconnect test also runs against the six installed packages.

`alp web` ships in the CLI (the `alp-web` service) and needs no plugin. To pair
Paseo's app on another device after upgrading core, install `@anhlp/alp-paseo`
separately and run `alp-paseo-integration --register` in the intended `ALP_HOME`
(global PATH discovery also works). See the [plugin installation and compatibility notes](../integrations/paseo/README.md#optional-web-installation).
