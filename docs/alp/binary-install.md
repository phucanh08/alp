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
| `--dir <path>` | Puts the `alp` command in `<path>` (default `~/.alp/bin`, or `<root>/bin` with `--root`). |
| `--root <path>` | Puts the bundle in `<path>/app` (default `~/.alp`). Without `--dir` (and without `--system`) the command goes to `<path>/bin`, and no shell profile is edited unless `--modify-path` is given, so such an install writes nothing in `~/.alp` or your profile. With `--dir` or `--system` as well, the profile is edited as before. |
| `--no-modify-path` | Leaves your shell profile alone and only prints the PATH line. |
| `--modify-path` | Edits the shell profile even with `--root` alone. |
| `--base-url <url or dir>` | Reads `SHA256SUMS` and the archives from a mirror (`file://` or an absolute directory works too). Same as `ALP_INSTALL_BASE_URL`. |

What the installer does:

1. It detects the OS and architecture. A shell running under Rosetta 2 on an Apple silicon Mac still gets the native arm64 build. It refuses musl (Alpine) and Windows (use `install.ps1`, below).
2. It downloads `SHA256SUMS` and takes the archive name `alp-<version>-<os>-<arch>.tar.gz` from it, so it makes no GitHub API call.
3. It downloads the archive and checks its sha256. Nothing is installed if the check fails.
4. It unpacks the archive into a staging directory beside the versions (`<root>/app/.alp-update-*`), checks that the bundle's `bin/alp --version` reports the release's version, and moves it to `<root>/app/<version>`. Reinstalling the version in use (current, or the one a running alpd uses) first moves the old copy aside (`.alp-old-*`), so processes running from it keep their files. Then `app/current` points at the new version.
5. It links `<dir>/alp` to `<root>/app/current/bin/alp`, renaming the link over the old command (a single-file `alp` from 0.0.1-beta.5/6 included), so a running `alp` keeps its file.
6. It removes older versions and leftovers of earlier installs, keeping the one that was current before and the one a running alpd uses (from `alpd.lock`).
7. If the directory is not on `PATH`, it adds (unless `--no-modify-path`, or `--root` alone without `--modify-path`) one line to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, fish's `conf.d/alp.fish`, or `~/.profile`). It adds the line only once.
8. It runs `alp --version`.

**A pre-created `ALP_HOME`.** alpd keeps its socket in `ALP_HOME`, which must be yours with mode 0700. If you made the directory yourself (`mkdir`, `mktemp -d`) and it is still empty, ALP tightens it to 0700 on first start. One that already holds files is left alone and alpd stops with `ALP_HOME_UNUSABLE` and the exact command, such as `chmod 700 "/path/to/home"`.

`--dir` and `--root` accept plain path characters only, and the mirror must be `https://` or `file://`. To check provenance yourself, run `gh attestation verify alp-<version>-<os>-<arch>.tar.gz --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml`. Anyone with write access can change a workflow on a branch, so an archive only counts as a release if it was attested from main by this workflow. A `file://` mirror needs curl, because wget reads https only.

### Windows

```powershell
irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1 | iex
```

`install.ps1` takes `-Version <v>`, `-Dir <path>`, `-Root <path>`, `-NoModifyPath`, `-ModifyPath` and `-BaseUrl <https://, file:// or an absolute directory>`. With `| iex`, set `ALP_INSTALL_VERSION`, `ALP_INSTALL_DIR`, `ALP_INSTALL_ROOT`, `ALP_INSTALL_NO_MODIFY_PATH=1`, `ALP_INSTALL_MODIFY_PATH=1` or `ALP_INSTALL_BASE_URL` instead, or run `& ([scriptblock]::Create((irm <url>/install.ps1))) -Version <v>`. It works in Windows PowerShell 5.1 and PowerShell 7. It reports an error by throwing, never with `exit`, so a failure does not close the shell you piped it into, and its body runs in a child scope, so it keeps its working variables and preferences out of your session; under `| iex` only its parameter variables (`$Version`, `$Dir`, `$Root`, `$NoModifyPath`, `$ModifyPath`, `$BaseUrl`, `$Help`) stay defined, and `$env:Path` gains the directory.

1. It refuses anything but Windows. On arm64 Windows it warns and installs the x64 build, which runs under emulation.
2. It downloads `SHA256SUMS` and takes `alp-<version>-windows-x64.zip` from it, with no GitHub API call.
3. It checks the zip with `Get-FileHash -Algorithm SHA256` before extracting anything, and runs `Unblock-File` on it to drop the Mark of the Web.
4. It unpacks the zip (with Windows' `tar.exe`) beside the versions, checks that the bundle reports the release's version, moves it to `<Root>\app\<version>` and points the junction `<Root>\app\current` at it. `-Dir` defaults to `%LOCALAPPDATA%\Programs\alp` (`~\.alp\bin` if `LOCALAPPDATA` is unset) and `-Root` to `-Dir`; `-Root` without `-Dir` puts `alp.cmd` in `<Root>\bin` and leaves the user `Path` alone unless `-ModifyPath` is given. `-Dir` may not contain `;`.
5. It writes `<Dir>\alp.cmd`, which runs `app\current`'s Node and CLI. The `alp.exe` of a 0.0.1-beta.5/6 single-file install would win over `alp.cmd` on `PATH`, so it is renamed to `alp.exe.old-<ticks>` (a running `.exe` can be renamed, not deleted), and the next install removes it.
6. It adds the directory to the front of your **user** `Path` once (not the machine `Path`, and no admin rights needed), and to the current session. It edits `HKCU\Environment` directly and keeps the value's kind (usually `REG_EXPAND_SZ`), so entries such as `%USERPROFILE%\bin` keep expanding. Open a new terminal to use `alp`.
7. It runs `alp --version`.

On Windows, terminals use node-pty (ConPTY) from the bundle's `node_modules`, best-effort with `protection: 'none'` (see [beta-install.md](beta-install.md)), exactly as an npm install does.

Not done yet: code signing and notarization (macOS Gatekeeper does not quarantine files downloaded with curl; Windows SmartScreen may warn about the unsigned `node.exe`), Homebrew, Windows arm64 and musl.

## Update

`alp update` installs the latest release beside the running one (`--version X` for a given one; `--check` only reports, `--yes` skips the question, which a run without a terminal needs). It downloads `SHA256SUMS` and this platform's archive, refuses a checksum mismatch, and, when `gh` is installed, runs `gh attestation verify <archive> --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml` and refuses a failure (sign in with `gh auth login`, or set `ALP_UPDATE_NO_GH=1` to rely on the checksum). Without `gh` it warns that only the checksum was checked. It then does what `install.sh` does: unpacks into `<root>/app/.alp-update-*`, checks `alp-bundle.json` and that the new bundle's own Node reports the expected `--version`, moves it to `<root>/app/<version>` and switches `app/current` (on macOS and Linux a new relative symlink renamed over the old one, in one step; on Windows the junction is replaced and put back if that fails). Nothing is changed before every check passed. The version this process runs and the one a running alpd uses stay until the next update; older versions and leftover staging directories are removed. On Windows, reinstalling the running version is refused (Windows cannot move a directory a running `node.exe` comes from): close ALP and rerun `install.ps1`. A running alpd of another version is not restarted: `alp update` says so and, at a terminal with no live session, offers `alp daemon restart`. `ALP_UPDATE_BASE_URL` (https://, file:// or a loopback http:// mirror) and `ALP_INSTALL_REPO` change the source.

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

`scripts/build-bundle.mjs --platform <os-arch>` packs the workspaces `@anhlp/alp-protocol`, `-core`, `-client` and `-cli` (`npm pack`, already built), installs them with `npm install --omit=dev --os --cpu [--libc=glibc]` into the bundle's `lib/`, with every third-party package that `package-lock.json` holds at one version pinned to it (`overrides`; the build fails if anything differs), drops type declarations, source maps and third-party READMEs, removes the Claude Code native packages and other platforms' prebuilds, downloads the pinned Node archive from nodejs.org and checks its sha256 (`scripts/node-runtime.json`; cached in `.cache/node`), keeps only `node` and its licence, and writes the launchers, `alp-bundle.json` and the licences. `scripts/package-binary.mjs pack --bundle <dir>` archives it; `sums <dir>` writes `SHA256SUMS`. To move to another Node release, change its version and all five sha256 values (from `https://nodejs.org/dist/v<version>/SHA256SUMS.txt`) together.

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

`@anhlp/alp` (source in `npm/alp`, outside the workspaces) is a thin wrapper for people who already have Node (22.12 or later). It holds only `bin/alp.js`, which imports `@anhlp/alp-cli/cli`, and it has exactly one dependency, `@anhlp/alp-cli`, pinned to its own version. It has no install scripts. `npm install -g @anhlp/alp@beta` therefore installs the same JavaScript CLI and alpd as the bundle, running on the user's Node. Outside the bundle, `alp update` prints the npm command (`npm install -g @anhlp/alp@beta`) and leaves the install to npm. Clients that look for alpd through `alp` on PATH, such as the Paseo plugin, follow npm's `bin/alp.js` to `@anhlp/alp-cli/dist/alpd.js` (`findDaemonEntry`). The per-platform packages `@anhlp/alp-<os>-<arch>` of t-cd7f are retired (t-1807) and are never published.

The libraries (`@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli`) and the Paseo plugin `@anhlp/alp-paseo` are JavaScript packages too. No package imports `@anhlp/alp`. The repository root is the private `alp-monorepo`.

A release is 8 tarballs, packed once from a clean clone at the release tag with `npm run release:pack -- --out <dir>`, then `npm run release:verify -- <dir>` and `npm run release:consumer -- <dir>` (the directory is a positional argument, not `--out`) on the saved files (`release-acceptance.yml` does this in CI). Publish order: the seven JavaScript packages, then `@anhlp/alp` last, so the wrapper never points at an `@anhlp/alp-cli` that is not on the registry. A5 (`release:verify`, `launcherProblems`) refuses a wrapper whose dependencies are not exactly `@anhlp/alp-cli@<version>`, one with optional dependencies or install scripts, or one that ships anything beyond `bin/alp.js` and its licence files.

`scripts/npm-wrapper-smoke.mjs` installs the wrapper as a user would: `npm install -g` of the 8 tarballs into a temporary prefix (with a throwaway HOME, ALP_HOME and npm cache), then npm's `alp --version`, `alp init` and `alp update`. `validate:packages` (CI `packages-and-web`) runs it on the rehearsal release; without an argument it packs the built workspaces itself. `test/integration/npm-wrapper.test.js` covers the wrapper's manifest and the passthrough of argv, stdio and exit codes.
