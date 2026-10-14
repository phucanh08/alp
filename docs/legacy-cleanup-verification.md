# Legacy source-directory cleanup verification

Date: 2026-10-14
Workspace: `/Users/anhlp/StudioProjects/alp-paseo`

## Backed-up directories

Legacy directories were copied before deletion to:

- `/tmp/alp-legacy-cleanup-backup-20261014T182939-34690`

Contents: `src/`, `plugins/paseo/`, `integrations/paseo-plugin/`, plus pre-cleanup metadata (`package.json`, tsconfigs, scripts, `test/monorepo.test.js`). Historical completed plan references remain untouched.

## Removed directories

- `src/`
- `plugins/paseo/`
- `integrations/paseo-plugin/`

No user data or templates were intentionally touched. Root `templates/` remains the editable source of truth.

## Canonical owners and package/bin changes

- Canonical plugin now lives at `packages/paseo` (`alp-paseo-plugin`, version `0.9.5`, plugin id `alp-provider`, selector alias `paseo-plugin` retained).
- The workspace manifest still publishes it as a public package.
- Root `package.json` bin changed from `src/cli.js` to `packages/cli/dist/cli.js`.
- Root `files` now ships built compatibility artifacts (`packages/cli/dist`, `packages/core/dist`, `packages/client/dist`, root `dist/alpd.js`, `dist/acp.js`, `dist/web-app`, `templates`, README, modular monorepo docs) instead of `src/*` or legacy plugin directories.
- Global npm link was refreshed; `alp` now points to `.../StudioProjects/alp-paseo/packages/cli/dist/cli.js`.
- A global CLI smoke passed with an isolated temporary `ALP_HOME` (Python removed? no runtime change).

## Build/tooling changes

- `scripts/build-paseo.mjs` now builds root compatibility artifacts from canonical package sources and no longer copies output into `plugins/paseo` or `integrations/paseo-plugin`.
- `scripts/build-paseo-web.mjs` now targets only `dist/web-app` and `packages/paseo/server/dist/web-app`.
- `tsconfig.paseo.json` and `tsconfig.client.json` no longer include deleted directories.
- Active tests and E2E scripts now import from `packages/*` and use `packages/cli/src/cli.js`.
- The old wrapper-parity assertion in `test/monorepo.test.js` was replaced with a regression checking canonical plugin build artifacts, root CLI build presence, selector/package metadata, and absence of the three deleted directories after builds.
- `FakeAdapter` moved from `src/adapters/fake.js` to `test/support/fake-adapter.js`; `test/adapter.test.js` updated.

## Before / after test counts

Before cleanup:
- `npm test`: 413 pass, 0 fail, 0 skipped
- `npm run test:packages`: 511 pass, 0 fail, 0 skipped
- Aggregate reported: 924 passing test lines (overlapping coverage)

After cleanup:
- `npm test`: 413 pass, 0 fail, 0 skipped
- `npm run test:packages`: 511 pass, 0 fail, 0 skipped

## Mandatory gate results after cleanup

| Gate | Exit code |
|---|---:|
| `npm run check:boundaries` | 0 |
| `npm run check` | 0 |
| `npm test` | 0 |
| `npm run test:packages` | 0 |
| `npm run build:packages` | 0 |
| `npm run release:pack-check` | 0 (7 packages verified) |
| `npm run test:packages:smoke` | 0 |
| `git diff --check` | 0 |
| `npm run build` | 0 |

Logs: `/tmp/alp-opencode-cleanup-*.log`.

## Live E2E tests

No live model E2E tests were executed. All 14 opt-in E2E scripts remain unrun; those requiring Claude/Codex credentials or real Paseo sessions were not touched in a way that claims completion:

- `scripts/alpd-e2e.mjs`
- `scripts/board-e2e.mjs`
- `scripts/claude-e2e.mjs`
- `scripts/claude-runtime-e2e.mjs`
- `scripts/human-e2e.mjs`
- `scripts/import-e2e.mjs`
- `scripts/mailbox-e2e.mjs`
- `scripts/paseo-e2e.mjs`
- `scripts/persistence-e2e.mjs`
- `scripts/runtime-e2e.mjs`
- `scripts/team-e2e.mjs`
- `scripts/viewer-detach-e2e.mjs`
- `scripts/workflow-e2e.mjs`
- `scripts/worktree-e2e.mjs`

## Live Paseo state

The running Paseo daemon and sessions were not stopped, restarted, or modified. Existing configuration already points at `packages/paseo`; no live-host change was made.

## Artifact-complete verification

- `packages/cli/dist/alpd.js` is a required compatibility artifact and is present in the live repository, clean-source checkout, and packed root tarball.
- Clean-source checkout (`npm ci --ignore-scripts` then `npm test`) passed: 413 tests, 0 fail.
- Root tarball consumer installation passed with only declared ALP dependencies; the installed CLI and daemon entry are present and runnable.
- No tests were skipped or assertions loosened; service lifecycle test now installs/runs the same canonical `packages/cli/dist/alpd.js` the CLI uses.

## Backward-compatibility limits

- Old repository source paths (`src/*`, `plugins/paseo/*`, `integrations/paseo-plugin/*`) no longer exist.
- Consumers must use canonical package paths such as `packages/*/src/*`, workspace imports, or built `dist` artifacts.
- Root `@anhlp/alp` remains installable, but ships built compatibility artifacts instead of legacy source trees.
- Compatibility wrappers that merely re-exported canonical source have been intentionally removed.
