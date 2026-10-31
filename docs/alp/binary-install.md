# The ALP bundle (t-1807)

ALP ships two ways. Both run the same JavaScript, `@anhlp/alp-cli`, on Node:

- **npm**: `npm install -g @anhlp/alp@beta` (see [npm packages](#npm-packages)). It uses your Node (22.12 or later).
- **The ALP bundle** (`install.sh`, `install.ps1`, GitHub Releases): macOS and Linux (glibc), arm64 and x64, and Windows x64 (best-effort). It needs no Node: it carries the official Node release it runs on, the way Paseo's daemon runs on Electron's Node.

Up to 0.0.1-beta.6 the release was one file built with `bun build --compile` (t-1e02). That build needed a special case for every computed import, native add-on and `process.execPath` spawn (0.0.1-beta.5 lost the Claude Agent SDK). The bundle is the npm install itself, so those special cases are gone; see [Upgrading from the single-file alp](#upgrading-from-the-single-file-alp-005-beta5beta6).

## Layout

One archive per platform, `alp-<version>-<os>-<arch>.tar.gz` (`alp-<version>-windows-x64.zip`), holding one directory:

```
alp-<version>-<os>-<arch>/
  bin/alp                 sh launcher (bin/alp.cmd on Windows)
  node/bin/node           the official Node release, checksum-pinned in scripts/node-runtime.json (node/node.exe on Windows), and its LICENSE
  lib/node_modules/       @anhlp/alp-cli and its production dependencies, as `npm install -g @anhlp/alp-cli` lays them out
  alp-bundle.json         { name: "alp", version, platform, node }
  LICENSE  NOTICE  THIRD-PARTY-NOTICES.txt
```

The launcher follows symlinks to its own directory and runs `node/bin/node lib/node_modules/@anhlp/alp-cli/dist/cli.js "$@"`. `process.execPath` is then the bundled Node, so alpd, `alp web`, the ACP agent and the MCP bridges start exactly as they do from npm (`node alpd.js`, `node -e <bridge>`).

Left out on purpose: `@anthropic-ai/claude-agent-sdk-<platform>`, the native Claude Code CLI of every platform (about 250 MB). ALP always runs your own `claude` (or `ALP_CLAUDE_BIN`). node-pty keeps only this platform's prebuild, and the native terminal helper only this platform's slot.

Installed, the bundle lives in `<root>/app/<version>/`, and `<root>/app/current` points at the version in use (a relative symlink; a junction on Windows). The `alp` command links to `<root>/app/current/bin/alp`. Anything that outlives the process (the launchd or systemd service, alpd's install record `alpd.json`) names the bundle through `app/current`, never a version directory, so an update cannot leave it pointing at a removed version (`stablePath` in `@anhlp/alp-core/packaged`).

## Install

```sh
curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh
```

| Option | Effect |
| --- | --- |
| `--version <v>` | Installs that release (tag `v<v>`) instead of the latest. Releases up to 0.0.1-beta.6 are single files that this installer does not install. |
| `--system` | Installs the bundle to `/usr/local/lib/alp/app` and the command to `/usr/local/bin`. It uses `sudo` only when a directory is not writable. |
| `--dir <path>` | Puts the `alp` command in `<path>` (default `~/.alp/bin`). |
| `--root <path>` | Puts the bundle in `<path>/app` (default `~/.alp`). |
| `--no-modify-path` | Leaves your shell profile alone and only prints the PATH line. |
| `--base-url <url or dir>` | Reads `SHA256SUMS` and the archives from a mirror (`file://` or an absolute directory works too). Same as `ALP_INSTALL_BASE_URL`. |

What the installer does:

1. It detects the OS and architecture. A shell running under Rosetta 2 on an Apple silicon Mac still gets the native arm64 build. It refuses musl (Alpine) and Windows (use `install.ps1`, below).
2. It downloads `SHA256SUMS` and takes the archive name `alp-<version>-<os>-<arch>.tar.gz` from it, so it makes no GitHub API call.
3. It downloads the archive and checks its sha256. Nothing is installed if the check fails.
4. It unpacks the archive into a staging directory beside the versions (`<root>/app/.alp-update-*`), checks that the bundle's `bin/alp --version` reports the release's version, and moves it to `<root>/app/<version>`. Reinstalling the version in use first moves the old copy aside (`.alp-old-*`), so processes running from it keep their files. Then `app/current` points at the new version.
5. It links `<dir>/alp` to `<root>/app/current/bin/alp`, renaming the link over the old command (a single-file `alp` from 0.0.1-beta.5/6 included), so a running `alp` keeps its file.
6. It removes older versions, keeping the one that was current before, for an alpd still running it.
7. If the directory is not on `PATH`, it adds one line to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, fish's `conf.d/alp.fish`, or `~/.profile`). It adds the line only once.
8. It runs `alp --version`.

`--dir` and `--root` accept plain path characters only, and the mirror must be `https://` or `file://`. To check provenance yourself, run `gh attestation verify alp-<version>-<os>-<arch>.tar.gz --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml`. Anyone with write access can change a workflow on a branch, so an archive only counts as a release if it was attested from main by this workflow. A `file://` mirror needs curl, because wget reads https only.

### Windows

```powershell
irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1 | iex
```

`install.ps1` takes `-Version <v>`, `-Dir <path>`, `-Root <path>`, `-NoModifyPath` and `-BaseUrl <https://, file:// or an absolute directory>`. With `| iex`, set `ALP_INSTALL_VERSION`, `ALP_INSTALL_DIR`, `ALP_INSTALL_ROOT`, `ALP_INSTALL_NO_MODIFY_PATH=1` or `ALP_INSTALL_BASE_URL` instead, or run `& ([scriptblock]::Create((irm <url>/install.ps1))) -Version <v>`. It works in Windows PowerShell 5.1 and PowerShell 7. It reports an error by throwing, never with `exit`, so a failure does not close the shell you piped it into, and its body runs in a child scope, so it leaves no variables or preferences behind (only `$env:Path` gains the directory).

1. It refuses anything but Windows. On arm64 Windows it warns and installs the x64 build, which runs under emulation.
2. It downloads `SHA256SUMS` and takes `alp-<version>-windows-x64.zip` from it, with no GitHub API call.
3. It checks the zip with `Get-FileHash -Algorithm SHA256` before extracting anything, and runs `Unblock-File` on it to drop the Mark of the Web.
4. It unpacks the zip (with Windows' `tar.exe`) beside the versions, checks that the bundle reports the release's version, moves it to `<Root>\app\<version>` and points the junction `<Root>\app\current` at it. `-Dir` defaults to `%LOCALAPPDATA%\Programs\alp` (`~\.alp\bin` if `LOCALAPPDATA` is unset) and `-Root` to `-Dir`. `-Dir` may not contain `;`.
5. It writes `<Dir>\alp.cmd`, which runs `app\current`'s Node and CLI. The `alp.exe` of a 0.0.1-beta.5/6 single-file install would win over `alp.cmd` on `PATH`, so it is renamed to `alp.exe.old-<ticks>` (a running `.exe` can be renamed, not deleted), and the next install removes it.
6. It adds the directory to the front of your **user** `Path` once (not the machine `Path`, and no admin rights needed), and to the current session. It edits `HKCU\Environment` directly and keeps the value's kind (usually `REG_EXPAND_SZ`), so entries such as `%USERPROFILE%\bin` keep expanding. Open a new terminal to use `alp`.
7. It runs `alp --version`.

On Windows, terminals use node-pty (ConPTY) from the bundle's `node_modules`, best-effort with `protection: 'none'` (see [beta-install.md](beta-install.md)), exactly as an npm install does.

Not done yet: code signing and notarization (macOS Gatekeeper does not quarantine files downloaded with curl; Windows SmartScreen may warn about the unsigned `node.exe`), Homebrew, Windows arm64 and musl.

## Update

`alp update` installs the latest release beside the running one (`--version X` for a given one; `--check` only reports, `--yes` skips the question, which a run without a terminal needs). It downloads `SHA256SUMS` and this platform's archive, refuses a checksum mismatch, and, when `gh` is installed, runs `gh attestation verify <archive> --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml` and refuses a failure (sign in with `gh auth login`, or set `ALP_UPDATE_NO_GH=1` to rely on the checksum). Without `gh` it warns that only the checksum was checked. It then does what `install.sh` does: unpacks into `<root>/app/.alp-update-*`, checks `alp-bundle.json` and that the new bundle's own Node reports the expected `--version`, moves it to `<root>/app/<version>` and switches `app/current` (on macOS and Linux a new relative symlink renamed over the old one, in one step; on Windows the junction is replaced and put back if that fails). Nothing is changed before every check passed. The version this process runs stays until the next update; older versions and leftover staging directories are removed. A running alpd of another version is not restarted: `alp update` says so and, at a terminal with no live session, offers `alp daemon restart`. `ALP_UPDATE_BASE_URL` (https://, file:// or a loopback http:// mirror) and `ALP_INSTALL_REPO` change the source.

`alp update` updates only a bundle that `install.sh` or `install.ps1` installed (one that `app/current` points at); for a bundle unpacked by hand it says to use the installer. An npm install prints the npm command instead.

The project template upgrade that `alp update` ran before is `alp update-template [directory]` (`alp upgrade` still works).

## Upgrading from the single-file alp (0.0.1-beta.5/beta.6)

The single-file `alp` cannot update itself to the bundle: its `alp update` replaces one file. Rerun the installer once; after that `alp update` works as above.

```sh
alp daemon stop        # optional: alpd keeps running the old file until it is restarted
curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh
alp daemon restart
```

- `~/.alp/bin/alp` becomes a link to `~/.alp/app/current/bin/alp`; `install.sh` renames it over the old file, so a running alpd is not disturbed. On Windows, `install.ps1` renames `alp.exe` aside and installs `alp.cmd`.
- A launchd or systemd service installed by the single-file build runs `~/.alp/bin/alp daemon run --service`. That still works with the bundle's launcher. `alp daemon install` writes the new form (`<root>/app/current/node/bin/node <root>/app/current/lib/node_modules/@anhlp/alp-cli/dist/alpd.js --service`).
- MCP entries that the single-file build wrote as `alp bridge acp|antigravity` are still recognised as ALP's; `alp setup` rewrites them as `node -e <bridge>` under the bundled Node.
- `<ALP_HOME>/cache/<version>/` (the single-file build's extracted assets) and `~/.alp/share/doc/alp` are no longer used and may be deleted.

## How the bundle is built

`scripts/build-bundle.mjs --platform <os-arch>` packs the workspaces `@anhlp/alp-protocol`, `-core`, `-client` and `-cli` (`npm pack`, already built), installs them with `npm install --omit=dev --os --cpu [--libc=glibc]` into the bundle's `lib/`, removes the Claude Code native packages and other platforms' prebuilds, downloads the pinned Node archive from nodejs.org and checks its sha256 (`scripts/node-runtime.json`; cached in `.cache/node`), keeps only `node` and its licence, and writes the launchers, `alp-bundle.json` and the licences. `scripts/package-binary.mjs pack --bundle <dir>` archives it; `sums <dir>` writes `SHA256SUMS`. To move to another Node release, change its version and all five sha256 values (from `https://nodejs.org/dist/v<version>/SHA256SUMS.txt`) together.

## Build and test locally

```sh
npm ci && node scripts/build-bundle.mjs                 # dist/bundle/alp-<version>-<this platform>
node scripts/binary-smoke.mjs                           # full smoke: launcher, daemon, web, terminal, fake Codex and Claude, bridge
node scripts/binary-update-smoke.mjs                    # install.sh into a temporary root, then alp update from file:// and HTTP mirrors
env -i PATH=/usr/bin:/bin sh scripts/binary-smoke-nodeless.sh dist/bundle/alp-<version>-<platform>/bin/alp   # no system Node
node scripts/package-binary.mjs pack --bundle dist/bundle/alp-<version>-<platform> --out dist/release
node --test test/integration/binary-release.test.js     # archive layout and install.sh against a file:// mirror
```

On Windows (PowerShell, from the repository):

```powershell
npm ci; node scripts/build-bundle.mjs                   # dist\bundle\alp-<version>-windows-x64
node scripts/binary-smoke.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\binary-smoke-nodeless.ps1 dist\bundle\alp-<version>-windows-x64\bin\alp.cmd
node --test test/integration/binary-install-ps1.test.js  # changes your user Path and restores it
```

## CI and releases

- **`binary` in `ci.yml`** (`.github/workflows/binary-build.yml`) runs on every PR and push to main. It builds natively on five runners: macos-15 (darwin-arm64), macos-15-intel (darwin-x64), ubuntu-24.04 (linux-x64), ubuntu-24.04-arm (linux-arm64) and windows-2022 (windows-x64). It runs the full smoke, the install-and-update smoke (`install.sh`, or `install.ps1` on Windows), and the smoke without a system Node: in `debian:bookworm-slim` on Linux, under `env -i PATH=/usr/bin:/bin` on macOS, and on Windows as `scripts/binary-smoke-nodeless.ps1` with `PATH` cut down to the Windows system directories. On Windows it also runs `install.ps1`'s tests (`test/integration/binary-install-ps1.test.js`, against a local mirror; they change the runner's user `Path` and restore it). Then it packs the archive (`.zip` on Windows) and reports its size. A separate job runs shellcheck on `install.sh` and checks that the PowerShell scripts parse.
- **`release-binaries.yml`** is started by hand with `workflow_dispatch` from main, with a `sha` input that must be a full commit on main. Its `draft` job runs in the `release` environment, which admits deployments from main only. It runs the same build. Then it writes `SHA256SUMS`, attests build provenance for every archive, `install.sh` and `install.ps1`, and creates a **draft** release `v<version>` (the version comes from `packages/cli/package.json`). An existing draft is replaced. A published release is never touched. The workflow never publishes anything. The owner reviews the draft and publishes it, and publishing creates the tag.
- **Version policy.** npm and the bundle share one version, the one in every `package.json`. npm keeps betas on the `beta` dist-tag. The binary release is a normal release, not a prerelease: the workflow creates the draft with `--prerelease=false` and fails if the draft says otherwise, because `releases/latest/download` resolves only to a published release that is not a prerelease. Do not tick "Set as a pre-release" when publishing, or `install.sh` without `--version` keeps installing the previous release.

## npm packages

`@anhlp/alp` (source in `npm/alp`, outside the workspaces) holds only `bin/alp.js` and `lib/launcher.js`. Its `optionalDependencies` pin the five platform packages to its own version:

| Package | `os` / `cpu` / `libc` | Contains |
|---|---|---|
| `@anhlp/alp-darwin-arm64` | darwin / arm64 | `bin/alp` |
| `@anhlp/alp-darwin-x64` | darwin / x64 | `bin/alp` |
| `@anhlp/alp-linux-x64` | linux / x64 / glibc | `bin/alp` |
| `@anhlp/alp-linux-arm64` | linux / arm64 / glibc | `bin/alp` |
| `@anhlp/alp-win32-x64` | win32 / x64 | `bin/alp.exe` |

Each one also carries README.md, LICENSE, NOTICE and the executable's THIRD-PARTY-NOTICES.txt, and it has no `bin`, scripts or dependencies. npm installs only the package that matches the machine. `alp` resolves that package and runs its executable with the same arguments and stdio. It forwards signals to the executable and ends the way the executable ended, with the same exit code or the same signal. If no platform package is installed (`--omit=optional`, musl, an unsupported platform), it exits 1 and suggests `--include=optional`, `install.sh` or the GitHub Releases page. The executable knows that it was installed by npm (it runs from `node_modules/@anhlp/alp-<os>-<arch>/bin/`), so `alp update` prints the npm command and leaves the file to npm. Clients that look for alpd through `alp` on PATH, such as the Paseo plugin, follow the launcher to the platform executable (`findDaemonEntry`).

The libraries (`@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli`) and the Paseo plugin `@anhlp/alp-paseo` remain JavaScript packages. No package imports `@anhlp/alp`. The repository root is the private `alp-monorepo`.

Platform packages are not stored in the repository. `scripts/npm-platform.mjs` generates them at release time from the GitHub release archives, which means npm and `install.sh` install byte-identical executables:

1. `release-binaries.yml` (run name `Release binaries <sha>`) drafts the GitHub release. It keeps the archives and SHA256SUMS as the 90-day artifact `alp-release-binaries`.
2. `release-acceptance.yml` is run with `sha` and `binaries_run` set to that run's id. It checks that the run is a successful release-binaries run of the same SHA on main, checks the archives against SHA256SUMS, and runs `release:pack --binaries <archives>`. Each platform package's executable is extracted from its archive. `release-manifest.json` records the executable's sha256 and size and the archive's name and sha256 under `binary`. A5 (`release:verify`) fails if a packed executable differs from that record.
3. Before publishing to npm, compare the `archiveSha256` values in the manifest with the SHA256SUMS asset of the GitHub release.
   For an already-published GitHub release, `release:pack --binaries-release v<version>` downloads the release's archives and SHA256SUMS with `gh` and refuses a draft or another version. The manifest records `pack.binariesRelease` (repo, tag, target commit), and that ties the platform packages to the release the same way `binariesRun` does. For a release `v<version>` (for example `v0.0.1-beta.6`, which is the first npm release; beta.5 was never published to npm), pack the 13 tarballs from a clean clone of the release commit. The tag `v<version>` belongs to the binary release, so `release:pack` needs a local tag at HEAD:

   ```sh
   git clone https://github.com/phucanh08/alp.git alp-npm && cd alp-npm && git checkout <release sha>
   git tag npm-v0.0.1-beta.6            # local only, never pushed: release:pack packs a tagged commit
   npm ci && npm run build:packages
   npm run release:pack -- --out /tmp/alp-npm-0.0.1-beta.6 --binaries-release v0.0.1-beta.6
   npm run release:verify -- /tmp/alp-npm-0.0.1-beta.6 --sha <release sha>
   npm run release:consumer -- /tmp/alp-npm-0.0.1-beta.6
   ```

4. Publish order: the seven JavaScript packages, then the five platform packages, then `@anhlp/alp` last, so the launcher never points at a version that is not on the registry.

`binary-build.yml` runs `scripts/npm-launcher-smoke.mjs` on all five runners. It packs that runner's platform package from its own archive, installs it and the launcher with `npm install -g` into a temporary prefix, and then runs `alp --version`, `alp init` and `alp update` through npm's `alp`. `test/integration/npm-wrapper.test.js` covers platform resolution, the missing-package messages, and passthrough of argv, stdio, exit codes and signals.
