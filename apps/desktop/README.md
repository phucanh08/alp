# ALP desktop (macOS)

An Electron shell over the ALP already installed on this Mac (D32, `docs/alp/desktop.md`). It runs
`alp web --print` and shows the ALP web app in its own window. It is a standalone **bun** project,
not one of the root npm workspaces: it has its own `bun.lock` and depends on no `@anhlp/*` package.

```sh
cd apps/desktop
bun install        # also fetches the Electron binary (install-electron)
bun test test      # unit tests of the pure modules
bun run typecheck
bun run build      # dist/main.cjs + dist/pages
bun run start      # build, then run Electron (ELECTRON_RUN_AS_NODE unset)
bun run e2e        # Electron e2e; needs the root `npm ci` and `node scripts/build-workspace.mjs cli`
```

| Variable | Use |
|---|---|
| `ALP_DESKTOP_ALP` | Absolute path of the `alp` to run, when the `alpPath` setting is not set. |
| `ALP_DESKTOP_USER_DATA` | Another data directory (tests, a second profile). |

Settings: `~/Library/Application Support/ALP/settings.json`, `{ "alpPath": "/absolute/path/to/alp" }`.

`alp web` refuses to run in a process started by an ALP agent (`ALP_AGENT_SESSION`). Try the app
from an agent against a disposable host (a scratch `ALP_HOME`) and a fake `alp` that prints that
host's address, never against the user's `~/.alp`.
