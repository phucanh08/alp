# @anhlp/alp-client

Local IPC client, daemon discovery, supervision, services and setup helpers.

`startIntegration` discovers an optional integration's descriptor and starts it detached with `--service`, so the entry writes its own log; discovery and the selected `ALP_HOME` are pinned by tests. Restarting is non-destructive: a daemon left running by an older install is reported as older than the current CLI and is never killed in place.

Build: `npm run build --workspace=@anhlp/alp-client`. Test: `npm run test --workspace=@anhlp/alp-client`.

Public imports use the package root and its explicitly exported subpaths. See [architecture, provider extension, compatibility and release instructions](../../docs/modular-monorepo.md).
