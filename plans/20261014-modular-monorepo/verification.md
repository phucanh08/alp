# Migration verification — 2026-10-14

## Baseline and compatibility

Before changes: `npm test` passed 408/408 tests, no skips. After migration: `npm test` passed 412/412, no skips. The four added tests enforce workspace dependency ownership, v1 wire/event/method fixtures, provider override precedence and emitted event schemas.

Existing tests were retained. Architecture assertions now inspect canonical package sources, and plugin client assertions inspect the canonical integration path. These changes preserve the original SDK/module restrictions rather than bypassing them.

No user ALP data/configuration was migrated. Root `@anhlp/alp`, `src/cli.js`, legacy source imports, plugin id/package name and `plugins/paseo` checkout installation remain supported. File and wire formats remain unchanged.

## Package test gates

`npm run test:packages` passed every publishable workspace's suite (some regression tests intentionally overlap):

| Package | Passed | Failed |
|---|---:|---:|
| protocol | 4 | 0 |
| core | 121 | 0 |
| runtime | 168 | 0 |
| client | 35 | 0 |
| daemon | 48 | 0 |
| cli | 76 | 0 |
| Paseo plugin | 57 | 0 |

TUI is reserved, private and has no implementation/test command.

## Build, graph and release gates

- `npm run check`: TypeScript server/runtime and client checks pass.
- `npm run check:boundaries`: all eight workspace manifests satisfy the allowed graph; no cycles or undeclared source imports.
- `npm run build:packages`: every publishable package builds, including declaration output and executable distributions.
- `npm run release:pack-check`: all seven publishable workspace tarball previews contain their declared public JS/type exports and binaries; real prepack scripts execute.
- `npm pack --dry-run --json`: the compatibility root distribution prepack passes and its legacy entrypoints are included.
- `git diff --check`: clean.

## Standalone installation gate

`npm run test:packages:smoke` packs and installs workspace tarballs plus the legacy root package into a temporary directory. No repository workspace links are used. Checks include:

- Importing six package root APIs, Paseo server and ACP bundle.
- A strict TypeScript consumer against the installed declaration exports.
- Installed CLI init, upgrade, language, agents, teams and daemon start/status/stop.
- Legacy root source API imports and CLI init, upgrade, language and daemon lifecycle.

Paseo supplies React Native client peers; the server smoke intentionally omits installing a React Native host. Existing client bundle tests still validate every client external against Paseo's supplied module list.

## Clean-source review

Read-only reviewer checked copied source fixtures without dist artifacts: `npm run check` passed, `npm run test:init` passed 5/5, and `npm ci --dry-run --ignore-scripts` accepted the lockfile. Compatibility plugin paths use real directories/wrappers instead of symbolic links for portable checkouts.

## Refactor evidence and limits

CLI dispatch reduced from 1,251 to 21 lines, split into command domains. Main runtime reduced from 5,012 to 3,545 lines by extracting contracts, tool schemas, handoff parsing, provider construction, native session configuration, board persistence, worktree/verification, internal state types and pure result helpers. Stateful session/delegation orchestration remains in its coordinator to preserve timing and state semantics.

Provider factories and legacy injection share the same normalized transport contract. Legacy transport injection remains highest priority. Board/worktree domain factories retain typed callbacks, shared map identities and write/merge ordering; focused tests and the complete suites validate those seams.

Live provider E2E scripts were not run: they require authenticated Claude/Codex/ACP harnesses and, for some scripts, a live Paseo host. No real model calls, npm publication, Rust implementation or TUI implementation were performed. This is evidence of hermetic regression/packaging compatibility, not a claim that every external provider deployment has been exercised.
