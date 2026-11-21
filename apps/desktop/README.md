# ALP desktop (macOS)

An Electron shell over the ALP already installed on this Mac (D32, `docs/alp/desktop.md`). It runs
`alp dashboard --print` and shows the ALP dashboard app in its own window. With no `alp` on the Mac it offers to install
the latest ALP release with the `install.sh` it was built with, after the user confirms (D35, `docs/alp/desktop.md` §3.2). It is a standalone **bun** project,
not one of the root npm workspaces: it has its own `bun.lock` and depends on no `@anhlp/*` package.

```sh
cd apps/desktop
bun install        # also fetches the Electron binary (install-electron)
bun test test      # unit tests of the pure modules
bun run typecheck
bun run build      # dist/main.cjs + dist/pages
bun run start      # build, then run Electron (ELECTRON_RUN_AS_NODE unset)
bun run e2e        # Electron e2e; needs the root `npm ci` and `node scripts/build-workspace.mjs cli`
bun run dist       # release/ALP-<version>-arm64.dmg and -x64.dmg: ad-hoc signed, not notarized, not published
ALP_DESKTOP_DMG=release/ALP-0.0.0-arm64.dmg bun run e2e:packaged   # tests ALP.app from that DMG
```

Packaging (`electron-builder.yml`, `build/`): bundle `ALP.app`, id `com.anhlp.alp.shell` (the id
`alp desktop` opens), hardened runtime with ad-hoc signature, Electron fuses set. `package.json` has
`"packageManager"` and an empty `"workspaces"` only so electron-builder treats this directory, not the
npm root, as the project root. A downloaded DMG is quarantined: on macOS 15 open it once, then
System Settings › Privacy & Security › Open Anyway (`docs/alp/desktop.md` §6.1). The icon is drawn by
`node scripts/icon.mjs`.

| Variable | Use |
|---|---|
| `ALP_DESKTOP_ALP` | Absolute path of the `alp` to run, when the `alpPath` setting is not set. |
| `ALP_DESKTOP_USER_DATA` | Another data directory (tests, a second profile). |

Settings: `~/Library/Application Support/ALP/settings.json`, `{ "alpPath": "/absolute/path/to/alp" }`.

`alp dashboard` refuses to run in a process started by an ALP agent (`ALP_AGENT_SESSION`). Try the app
from an agent against a disposable host (a scratch `ALP_HOME`) and a fake `alp` that prints that
host's address, never against the user's `~/.alp`. Pass `--use-mock-keychain` to any automated launch
with a scratch `HOME`: there is no login keychain there, and the packaged app would otherwise put a
"Keychain Not Found" dialog on the user's screen.
