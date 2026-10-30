# The ALP executable (t-1e02)

ALP ships two ways. They behave the same:

- **npm**: `npm install -g @anhlp/alp`. It needs Node 22 or later. Use it on Windows until the Windows executable is ready (P2).
- **One executable** (`alp`): macOS and Linux (glibc), arm64 and x64. It needs no Node. It contains the CLI, alpd, `alp web` with its browser app, the ACP agent, the templates and the native terminal helper.

## Install

```sh
curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh
```

| Option | Effect |
| --- | --- |
| `--version 0.1.0` | Installs that release (tag `v0.1.0`) instead of the latest. |
| `--system` | Installs to `/usr/local/bin`. It uses `sudo` only when the directory is not writable. |
| `--dir <path>` | Installs to `<path>`. |
| `--no-modify-path` | Leaves your shell profile alone and only prints the PATH line. |
| `--base-url <url or dir>` | Reads `SHA256SUMS` and the archives from a mirror (`file://` or an absolute directory works too). Same as `ALP_INSTALL_BASE_URL`. |

What the installer does:

1. It detects the OS and architecture. A shell running under Rosetta 2 on an Apple silicon Mac still gets the native arm64 build. It refuses musl (Alpine) and Windows.
2. It downloads `SHA256SUMS` and takes the archive name `alp-<version>-<os>-<arch>.tar.gz` from it, so it makes no GitHub API call.
3. It downloads the archive and checks its sha256. Nothing is installed if the check fails.
4. It installs `alp` to `~/.alp/bin`, replacing the file atomically so a running `alp` is not disturbed. The licences go to `share/doc/alp` beside the install directory (`~/.alp/share/doc/alp`, `/usr/local/share/doc/alp`); it warns if it cannot write them. `--dir` accepts plain path characters only, and the mirror must be `https://` or `file://`.
5. If the directory is not on `PATH`, it adds one line to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, fish's `conf.d/alp.fish`, or `~/.profile`). It adds the line only once.
6. It runs `alp --version`.

To check provenance yourself, run `gh attestation verify alp-<version>-<os>-<arch>.tar.gz --repo phucanh08/alp --source-ref refs/heads/main --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml`. Anyone with write access can change a workflow on a branch, so an archive only counts as a release if it was attested from main by this workflow. A `file://` mirror needs curl, because wget reads https only. With `--system`, it may ask for sudo a second time to write `/usr/local/share/doc/alp`.

Not done yet: code signing and notarization (macOS Gatekeeper does not quarantine files downloaded with curl), `alp self-update` and Homebrew (P3), Windows (P2), musl, and an x64-baseline build for CPUs without AVX2.

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

## CI and releases

- **`binary` in `ci.yml`** (`.github/workflows/binary-build.yml`) runs on every PR and push to main. It builds natively on four runners: macos-14 (darwin-arm64), macos-15-intel (darwin-x64), ubuntu-24.04 (linux-x64) and ubuntu-24.04-arm (linux-arm64), with a pinned `oven-sh/setup-bun` and Bun 1.4.2. It runs both smokes. The Node-less smoke runs in `debian:bookworm-slim` on Linux and under `env -i PATH=/usr/bin:/bin` on macOS. Then it packs the archive. A separate job runs shellcheck on `install.sh`.
- **`release-binaries.yml`** is started by hand with `workflow_dispatch` from main. Its `draft` job runs in the `release` environment, which admits deployments from main only and a `sha` input, which must be a full commit on main. It runs the same build. Then it writes `SHA256SUMS`, attests build provenance for every archive and `install.sh`, and creates a **draft** release `v<version>` (the version comes from `packages/cli/package.json`). An existing draft is replaced. A published release is never touched. The workflow never publishes anything. The owner reviews the draft and publishes it, and publishing creates the tag.
- `releases/latest/download` resolves only to a published release that is not marked as a prerelease. If a beta is published as a prerelease, install it with `--version`.
