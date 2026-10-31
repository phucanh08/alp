# ALP on a bundled Node runtime, as Paseo's daemon (2026-10-30)

Decision (anh, 2026-10-30): replace the `bun build --compile` single-file executable (t-1e02) with
the layout Paseo's daemon uses: a JavaScript runtime shipped with the app, the JS build, real
`node_modules` and a small launcher. Paseo uses Electron's Node (`ELECTRON_RUN_AS_NODE=1`); ALP has no
Electron app, so it ships the official Node release. Users still need no Node installed.

Why: under `bun --compile` every computed import, native addon and `process.execPath` spawn needs a
special case (0.0.1-beta.5 lost the Claude SDK, #274; Windows needed an fd writer for ConPTY and an
embedded conpty.dll; `packaged.js` extracts assets to a cache). Under Node, ALP runs exactly as the
npm package `@anhlp/alp-cli` already does; those special cases go away.

## Layout (one archive per platform)

```
alp-<version>-<os>-<arch>/
  bin/alp            sh launcher (bin/alp.cmd on Windows)
  node/              official Node <24 LTS> for the platform (bin/node or node.exe), checksum-pinned
  lib/node_modules/@anhlp/alp-cli/   npm install --omit=dev of the packed workspaces
  LICENSE NOTICE THIRD-PARTY-NOTICES.txt
```

Launcher: `exec "$ROOT/node/bin/node" "$ROOT/lib/node_modules/@anhlp/alp-cli/dist/cli.js" "$@"`
(symlinks resolved first, as Paseo's `bin/paseo`). `process.execPath` is then the bundled node, so
`selfCommand`, services and roles take their existing npm (script) path.

Excluded: `@anthropic-ai/claude-agent-sdk-<platform>` (~250 MB native `claude`). ALP always passes
`pathToClaudeCodeExecutable` from the user's `claude` (or `ALP_CLAUDE_BIN`).

## Install, update, services

- `install.sh` / `install.ps1`: extract to `~/.alp/app/<version>/`, point `~/.alp/app/current`
  (symlink; junction on Windows) at it, `~/.alp/bin/alp` → `current/bin/alp`. Services record the
  `current` path so an update does not leave launchd/systemd on a removed version.
- `alp update`: download + SHA256SUMS + provenance as now, extract to `app/<version>`, run its
  `--version`, swap `current` atomically, keep the previous version until the next start.
- Migration from beta.5/beta.6 single-file installs: their `alp update` replaces one file from the
  archive. Ship a top-level shim `alp` in the archive for one release, or tell users to rerun
  `install.sh`. (Open: decide before the first release.)
- npm: `@anhlp/alp` depends on `@anhlp/alp-cli` (npm users already have Node); per-platform
  `@anhlp/alp-<os>-<arch>` packages are retired. (Open: confirm.)

## Phases

1. `scripts/build-bundle.mjs`: pack workspaces, install into a staging prefix, fetch + verify Node,
   write launchers, drop the Claude native package. Local smoke: `alp run` with Claude on macOS.
2. `package-binary.mjs` → archives of the directory; `binary-smoke.mjs` against the bundle
   (+ a Claude SDK load check); CI `binary-build.yml` / `release-binaries.yml` on the 5 targets.
3. `install.sh`, `install.ps1`, `alp update` for the directory layout; services through `current`.
4. Remove Bun-only code: `packaged.js` asset extraction and roles, `isScript` guard, `BUN_BE_BUN`,
   Windows fd writer and embedded conpty, `modules` from #274. Docs: `binary-install.md`,
   `breaking-changes.md`.
5. npm: `@anhlp/alp` → alp-cli; retire platform packages.
