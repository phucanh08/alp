# @anhlp/alp-daemon

Persistent runtime hosting, local IPC server and neutral IPC extensions.

The daemon hosts *neutral* IPC extensions: a connection registers a method with `extension.register`, owns it until it disconnects or calls `extension.unregister`, and the daemon routes `extension.invoke` calls back to the owner. It assigns no meaning to a method and knows nothing about the optional Paseo integration, whose process data lives under the selected home (`$ALP_HOME/integrations`, `$ALP_HOME/logs/integrations`).

What survives a crash of the alpd process, when `session.prompt` is acknowledged, how long a `clientMessageId` is honoured, and what is not covered (power loss, disk failure): [ALPD §66](../../plans/reference/ALPD.md). `tests/crash-recovery.test.js` kills a real alpd at each point with a fake provider.

Build: `npm run build --workspace=@anhlp/alp-daemon`. Test: `npm run test --workspace=@anhlp/alp-daemon`.

Public imports use the package root and its explicitly exported subpaths. See [architecture, provider extension, compatibility and release instructions](../../docs/modular-monorepo.md).
