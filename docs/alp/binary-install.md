# The ALP executable (t-1e02)

ALP ships two ways. They behave the same:

- **npm**: `npm install -g @anhlp/alp`. It needs Node 22 or later.
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

`install.ps1` takes `-Version <v>`, `-Dir <path>`, `-NoModifyPath` and `-BaseUrl <https://, file:// or an absolute directory>`. With `| iex`, set `ALP_INSTALL_VERSION`, `ALP_INSTALL_DIR`, `ALP_INSTALL_NO_MODIFY_PATH=1` or `ALP_INSTALL_BASE_URL` instead, or run `& ([scriptblock]::Create((irm <url>/install.ps1))) -Version 0.0.1-beta.5`. It works in Windows PowerShell 5.1 and PowerShell 7. It reports an error by throwing, never with `exit`, so a failure does not close the shell you piped it into.

1. It refuses anything but Windows. On arm64 Windows it warns and installs the x64 build, which runs under emulation.
2. It downloads `SHA256SUMS` and takes `alp-<version>-windows-x64.zip` from it, with no GitHub API call.
3. It checks the zip with `Get-FileHash -Algorithm SHA256` before extracting anything, then runs `Unblock-File` on it and on `alp.exe` to drop the Mark of the Web.
4. It installs `alp.exe` to `%LOCALAPPDATA%\Programs\alp` (`~\.alp\bin` if `LOCALAPPDATA` is unset), with `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.txt` beside it. It stages the new file in that directory and renames it into place. Windows cannot overwrite a running `.exe`, so an existing `alp.exe` is first renamed to `alp.exe.old-<ticks>`, and the next install removes it.
5. It adds the directory to the front of your **user** `Path` once (not the machine `Path`, and no admin rights needed), and to the current session. Open a new terminal to use `alp`.
6. It runs `alp --version`.

On Windows, terminals use node-pty (ConPTY), best-effort with `protection: 'none'` (see [beta-install.md](beta-install.md)). The executable embeds node-pty's JavaScript and its win32-x64 prebuilt (`conpty.node`, `conpty/conpty.dll`, `conpty/OpenConsole.exe`, without `.pdb` files), and extracts them to `<ALP_HOME>\cache\<version>\node-pty`. The cache's 0700 owner checks are POSIX only; on Windows the cache relies on the ACL of your profile directory.

Not done yet: code signing and notarization (macOS Gatekeeper does not quarantine files downloaded with curl; Windows SmartScreen may warn about the unsigned `alp.exe`), `alp self-update` and Homebrew (P3), Windows arm64, musl, and an x64-baseline build for CPUs without AVX2.

## How the executable works

`scripts/build-binary.mjs` runs `bun build --compile` on the npm build output. It embeds the assets with a sha256 manifest. On first use, `@anhlp/alp-core/packaged` extracts them to `<ALP_HOME>/cache/<version>/`. The cache must be a private (0700) directory owned by you, and its parent must not be group- or world-writable. Each process checks every file's size and sha256 before reusing the cache. Staging directories left by a crashed extraction are removed once they are ten minutes old and their process is gone, or an hour old. The ten-minute wait covers an extractor in another pid namespace. After the rename, the cache is checked again. Concurrent first runs all end up with one complete cache.

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
