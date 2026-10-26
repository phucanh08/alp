# CI validation baseline

Run `npm ci`, then `npm run validate` from the repository root. The same entrypoint
runs in CI as independent lanes; a failed child command (including a signal or
startup error) stops its lane and returns a nonzero exit status.

| Command / CI job | Required checks, in order |
| --- | --- |
| `npm run validate:core` / `core` | Source boundaries; core typecheck; daemon + CLI workspace builds and neutral root bundles; artifact boundaries; all six core workspaces' unit tests; clean core-only source build/prepack; isolated six-package and main-distribution tarball installs with CLI/IPC/fake ACP stdio smoke |
| `npm run validate:paseo` / `paseo` | Existing server + client typechecks; workspace/plugin/root builds; Paseo unit tests; all cross-package integration tests |
| `npm run validate:packages` / `packages-and-web` | Pinned checkout of Paseo's plugin compiler (`scripts/paseo-checkout.mjs`); workspace/plugin/root builds; artifact boundaries; packed exports/bins; the release-pack rehearsal (eight tarballs, A5); isolated core and plugin tarball consumers, the plugin compiled by Paseo's own compiler (#111); package/compatibility-root installation smoke; gateway smoke |
| `npm run validate:web` / `alp-web` | apps/web typecheck, unit tests, and Playwright end to end against a real gateway and alpd (Ubuntu and macOS) |

`packages-and-web` keeps its name, a required check, but no longer builds or smokes Paseo's web
app: that app (`paseo-web/`, `scripts/build-paseo-web.mjs`, `scripts/web-app-smoke.mjs`) was
removed in t-55ce.3, and the browser app is tested by `alp-web`. The existing
Windows daemon subset remains in its own job. Core and Paseo retain Node 22/24 on
Ubuntu; packaging and browser validation use Node 22. This is not a full OS/Node
matrix or a publishing workflow.

No required lane invokes `test:e2e`, authenticates a provider, or needs model
credentials. Tests inject fake transports; standalone core copies `fake-acp.js`
and its driver into a temporary consumer outside the repository, installs only
the six core tarballs plus Node types, and rejects Paseo/React dependencies. It
exercises the installed runtime, daemon IPC, disconnect/replay and shutdown.
The packaging lane needs network access to Paseo's repository (the pinned compiler) and the npm registry.

Builds precede artifact checks explicitly. `check:boundaries` still supports
source-only runs before a build; CI uses `--require-artifacts` after building so
missing/unreadable bundles or manifests fail. The validation lane invokes
`pack-check.mjs --ignore-scripts` to inspect existing outputs rather than rebuild
through `prepack`. The existing `release:pack-check` and publishing/prepack
behavior is unchanged. No failure is marked `continue-on-error`, and no
test is filtered out to obtain a green baseline. Cross-package tests are labeled
with Paseo because that suite also exercises the optional integration; failures
there may still originate in core.

## Recorded local baseline

> Historical record from `0.10.0`. It is not evidence for the beta `0.0.0-beta.1`, whose gate
> runs on the release SHA ([beta-scope.md](alp/beta-scope.md) §6). The pinned web build and
> `scripts/web-app-smoke.mjs` it names were removed with Paseo's web app (t-55ce.3).

Base revision: `31e0ad1` (`0.10.0`). Environment: macOS, Node `26.3.0`, npm
`11.16.0`; these local results do not substitute for the Ubuntu/Windows CI runs.

Before wiring changes:

- `npm run check:boundaries`: passed.
- `npm run check`: passed (both existing TypeScript configurations).
- `npm test`: 450 passed, 0 failed, 0 skipped.

After wiring changes:

- `npm run validate:core`: passed; 178 unit tests, 0 skipped; isolated core install
  contained no Paseo/React and printed `STANDALONE_CORE_SMOKE_PASSED`.
- Missing-artifact regression: all 4 monorepo checks passed, including a fixture
  proving that source-only validation succeeds but strict artifact validation fails.
- `npm run validate:paseo`: passed; 126 Paseo unit tests and 147 integration tests
  (including the new missing-artifact regression), 0 failed and 0 skipped.
- `npm run validate:packages`: passed; pinned web build/provenance, all 7 public
  package exports/bins, isolated core and real-SDK plugin consumers, and the
  installed CLI/daemon/compatibility-root web integration smoke. The final
  `pack-check.mjs --ignore-scripts` path also passed independently.

- `node scripts/web-app-smoke.mjs`: passed in Chrome; connected start page and
  ALP plugin registration verified (86 seconds).

No pre-existing failing check was observed in the completed runs above. npm emitted
upstream dependency deprecation warnings during consumer installation; they did
not fail validation. No runtime/product implementation was changed for this task.
