# The ALP executable (t-1e02)

ALP ships two ways. They behave the same:

- **npm**: `npm install -g @anhlp/alp@beta`. Since t-cd7f this installs the same executable: `@anhlp/alp` is a small launcher (plain Node, no dependencies, no postinstall download) and npm installs the executable for the machine as one optional dependency, `@anhlp/alp-<os>-<arch>` (see [npm packages](#npm-packages)). The launcher needs Node 18 or later; ALP itself then runs without Node.
- **One executable** (`alp`, `alp.exe` on Windows): macOS and Linux (glibc), arm64 and x64, and Windows x64 (P2). It needs no Node. It contains the CLI, alpd, `alp web` with its browser app, the ACP agent, the templates and the native terminal helper.

## Install

```sh
curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh
```

| Option | Effect |
| --- | --- |
| `--version 0.0.1-beta.5` | Installs that release (tag `v0.0.1-beta.5`) instead of the latest. |
| `--system` | Installs to `/usr/local/bin`. It uses `sudo` only when the directory is not writable. |
| `--dir <path>` | Installs to `<path>`. |
| `--no-modify-path` | Leaves your shell profile alone and only prints the PATH line. |
| `--base-url <url or dir>` | Reads `SHA256SUMS` and the archives from a mirror (`file://` or an absolute directory works too). Same as `ALP_INSTALL_BASE_URL`. |

What the installer does:

1. It detects the OS and architecture. A shell running under Rosetta 2 on an Apple silicon Mac still gets the native arm64 build. It refuses musl (Alpine) and Windows (use `install.ps1`, below).
2. It downloads `SHA256SUMS` and takes the archive name `alp-<version>-<os>-<arch>.tar.gz` from it, so it makes no GitHub API call.
3. It downloads the archive and checks its sha256. Nothing is installed if the check fails.
4. It installs `alp` to `~/.alp/bin`, replacing the file atomically so a running `alp` is not disturbed. The licences go to `share/doc/alp` beside the install directory (`~/.alp/share/doc/alp`, `/usr/local/share/doc/alp`); it warns if it cannot write them. `--dir` accepts plain path characters only, and the mirror must be `https://` or `file://`.
5. If the directory is not on `PATH`, it adds one line to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, fish's `conf.d/alp.fish`, or `~/.profile`). It adds the line only once.
6. It runs `alp --version`.

To check provenance yourself, run `gh attestation verify alp-<version>-<os>-<arch>.tar.gz --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml`. Anyone with write access can change a workflow on a branch, so an archive only counts as a release if it was attested from main by this workflow. A `file://` mirror needs curl, because wget reads https only. With `--system`, it may ask for sudo a second time to write `/usr/local/share/doc/alp`.

### Windows

```powershell
irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1 | iex
```

`install.ps1` takes `-Version <v>`, `-Dir <path>`, `-NoModifyPath` and `-BaseUrl <https://, file:// or an absolute directory>`. With `| iex`, set `ALP_INSTALL_VERSION`, `ALP_INSTALL_DIR`, `ALP_INSTALL_NO_MODIFY_PATH=1` or `ALP_INSTALL_BASE_URL` instead, or run `& ([scriptblock]::Create((irm <url>/install.ps1))) -Version 0.0.1-beta.5`. It works in Windows PowerShell 5.1 and PowerShell 7. It reports an error by throwing, never with `exit`, so a failure does not close the shell you piped it into, and its body runs in a child scope, so it leaves no variables or preferences behind (only `$env:Path` gains the directory).

1. It refuses anything but Windows. On arm64 Windows it warns and installs the x64 build, which runs under emulation.
2. It downloads `SHA256SUMS` and takes `alp-<version>-windows-x64.zip` from it, with no GitHub API call.
3. It checks the zip with `Get-FileHash -Algorithm SHA256` before extracting anything, then runs `Unblock-File` on it and on `alp.exe` to drop the Mark of the Web.
4. It installs `alp.exe` to `%LOCALAPPDATA%\Programs\alp` (`~\.alp\bin` if `LOCALAPPDATA` is unset), with `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.txt` beside it. It stages the new file in that directory and renames it into place. Windows cannot overwrite a running `.exe`, so an existing `alp.exe` is first renamed to `alp.exe.old-<ticks>`, and the next install removes it. If the new file cannot be put in place, the old one is renamed back. `-Dir` may not contain `;`.
5. It adds the directory to the front of your **user** `Path` once (not the machine `Path`, and no admin rights needed), and to the current session. It edits `HKCU\Environment` directly and keeps the value's kind (usually `REG_EXPAND_SZ`), so entries such as `%USERPROFILE%\bin` keep expanding. Open a new terminal to use `alp`.
6. It runs `alp --version`.

On Windows, terminals use node-pty (ConPTY), best-effort with `protection: 'none'` (see [beta-install.md](beta-install.md)). The executable embeds node-pty's JavaScript and its win32-x64 prebuilt (`conpty.node`, `conpty/conpty.dll`, `conpty/OpenConsole.exe`, without `.pdb` files), and extracts them to `<ALP_HOME>\cache\<version>\node-pty`. It runs them with node-pty's `useConptyDll`, so terminals use the embedded ConPTY rather than the system one. With the system ConPTY, node-pty's `kill()` forks a helper script through `process.execPath`, which the executable cannot run. Under Bun, node-pty's input socket (`net.Socket({ fd })` on ConPTY's input pipe) drops writes, so the daemon hands node-pty a small fd writer instead (`packages/daemon/src/windows-terminal.ts`). The Windows archive's `THIRD-PARTY-NOTICES.txt` adds node-pty's licence and the MIT notice of Windows Terminal (conpty.dll, OpenConsole.exe). The cache's 0700 owner checks are POSIX only; on Windows the cache relies on the ACL of your profile directory.

Not done yet: code signing and notarization (macOS Gatekeeper does not quarantine files downloaded with curl; Windows SmartScreen may warn about the unsigned `alp.exe`), Homebrew, Windows arm64, musl, and an x64-baseline build for CPUs without AVX2.

## Update

`alp update` replaces the executable with the latest release (`--version X` for a given one; `--check` only reports, `--yes` skips the question, which a run without a terminal needs). It downloads `SHA256SUMS` and this platform's archive, refuses a checksum mismatch, and, when `gh` is installed, runs `gh attestation verify <archive> --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml` and refuses a failure (sign in with `gh auth login`, or set `ALP_UPDATE_NO_GH=1` to rely on the checksum). Without `gh` it warns that only the checksum was checked. The new file is staged beside the old one and must report the expected `--version`; on macOS and Linux it is renamed over the running `alp`, on Windows the running `alp.exe` is renamed to `alp.old.exe` first, which the next `alp` start deletes. A running alpd of another version is not restarted: `alp update` says so and, at a terminal with no live session, offers `alp daemon restart`. `ALP_UPDATE_BASE_URL` (https://, file:// or a loopback http:// mirror) and `ALP_INSTALL_REPO` change the source. An npm install prints the npm command instead.

The project template upgrade that `alp update` ran before is now `alp update-template [directory]` (`alp upgrade` still works).

## How the executable works

`scripts/build-binary.mjs` runs `bun build --compile` on the npm build output. It embeds the assets with a sha256 manifest. The runtime imports the Claude Agent SDK by a computed name that Bun cannot follow, so the generated entry imports it by its literal name and registers that import (`modules` in `registerPackaged`); without it every Claude session fails with `Cannot find package '@anthropic-ai/claude-agent-sdk'` (0.0.1-beta.5). On first use, `@anhlp/alp-core/packaged` extracts them to `<ALP_HOME>/cache/<version>/`. The cache must be a private (0700) directory owned by you, and its parent must not be group- or world-writable. Each process checks every file's size and sha256 before reusing the cache. Staging directories left by a crashed extraction are removed once they are ten minutes old and their process is gone, or an hour old. The ten-minute wait covers an extractor in another pid namespace. After the rename, the cache is checked again. Concurrent first runs all end up with one complete cache.

ALP starts its other roles through subcommands of the same file: `alp daemon run`, `alp web serve`, `alp bridge acp|antigravity`. It never spawns `process.execPath` with a script. `scripts/check-boundaries.mjs` enforces this. It catches `process.execPath`, `process['execPath']` and `const { execPath } = process` in `.js`, `.ts`, `.mjs` and `.cjs` sources.

## Build and test locally

```sh
npm ci && node scripts/build-binary.mjs                 # dist/bin/alp for this machine (needs bun 1.4.2)
node scripts/binary-smoke.mjs dist/bin/alp              # full smoke: daemon, web, terminal, fake provider, bridge
env -i PATH=/usr/bin:/bin sh scripts/binary-smoke-nodeless.sh dist/bin/alp   # without Node
node scripts/package-binary.mjs pack --binary dist/bin/alp --target bun-darwin-arm64 --out dist/release
node --test test/integration/binary-release.test.js     # archive layout and install.sh against a file:// mirror
```

On Windows (PowerShell, from the repository):

```powershell
npm ci; node scripts/build-binary.mjs                   # dist\bin\alp.exe
node scripts/binary-smoke.mjs dist\bin\alp.exe
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\binary-smoke-nodeless.ps1 dist\bin\alp.exe
node --test test/integration/binary-install-ps1.test.js  # changes your user Path and restores it
```

## CI and releases

- **`binary` in `ci.yml`** (`.github/workflows/binary-build.yml`) runs on every PR and push to main. It builds natively on five runners: macos-14 (darwin-arm64), macos-15-intel (darwin-x64), ubuntu-24.04 (linux-x64), ubuntu-24.04-arm (linux-arm64) and windows-2022 (windows-x64), with a pinned `oven-sh/setup-bun` and Bun 1.4.2. It runs both smokes; on Windows the full smoke opens a ConPTY terminal through the extracted node-pty. The Node-less smoke runs in `debian:bookworm-slim` on Linux, under `env -i PATH=/usr/bin:/bin` on macOS, and on Windows as `scripts/binary-smoke-nodeless.ps1` with `PATH` cut down to the Windows system directories. On Windows it also runs `install.ps1`'s tests (`test/integration/binary-install-ps1.test.js`, against a local mirror; they change the runner's user `Path` and restore it). Then it packs the archive (`.zip` on Windows). A separate job runs shellcheck on `install.sh` and checks that the PowerShell scripts parse.
- **`release-binaries.yml`** is started by hand with `workflow_dispatch` from main, with a `sha` input that must be a full commit on main. Its `draft` job runs in the `release` environment, which admits deployments from main only. It runs the same build. Then it writes `SHA256SUMS`, attests build provenance for every archive, `install.sh` and `install.ps1`, and creates a **draft** release `v<version>` (the version comes from `packages/cli/package.json`). An existing draft is replaced. A published release is never touched. The workflow never publishes anything. The owner reviews the draft and publishes it, and publishing creates the tag.
- **Version policy.** npm and the executable share one version, the one in every `package.json` (first: `0.0.1-beta.5`). npm keeps betas on the `beta` dist-tag. The binary release is a normal release, not a prerelease: the workflow creates the draft with `--prerelease=false` and fails if the draft says otherwise, because `releases/latest/download` resolves only to a published release that is not a prerelease. Do not tick "Set as a pre-release" when publishing, or `install.sh` without `--version` keeps installing the previous release.

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
   For an already-published GitHub release, `release:pack --binaries-release v<version>` downloads the release's archives and SHA256SUMS with `gh` and refuses a draft or another version. The manifest records `pack.binariesRelease` (repo, tag, target commit), and that ties the platform packages to the release the same way `binariesRun` does. For beta.5 (the GitHub release `v0.0.1-beta.5` from `2b63a7a`), pack the 13 tarballs from a clean clone of the merge commit. The tag `v0.0.1-beta.5` belongs to the binary release, so `release:pack` needs a local tag at HEAD:

   ```sh
   git clone https://github.com/phucanh08/alp.git alp-npm && cd alp-npm && git checkout <merge sha>
   git tag npm-v0.0.1-beta.5            # local only, never pushed: release:pack packs a tagged commit
   npm ci && npm run build:packages
   npm run release:pack -- --out /tmp/alp-npm-0.0.1-beta.5 --binaries-release v0.0.1-beta.5
   npm run release:verify -- /tmp/alp-npm-0.0.1-beta.5 --sha <merge sha>
   npm run release:consumer -- /tmp/alp-npm-0.0.1-beta.5
   ```

4. Publish order: the seven JavaScript packages, then the five platform packages, then `@anhlp/alp` last, so the launcher never points at a version that is not on the registry.

`binary-build.yml` runs `scripts/npm-launcher-smoke.mjs` on all five runners. It packs that runner's platform package from its own archive, installs it and the launcher with `npm install -g` into a temporary prefix, and then runs `alp --version`, `alp init` and `alp update` through npm's `alp`. `test/integration/npm-wrapper.test.js` covers platform resolution, the missing-package messages, and passthrough of argv, stdio, exit codes and signals.
