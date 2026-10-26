# @anhlp/alp-daemon

Persistent runtime hosting, local IPC server and neutral IPC extensions.

The daemon hosts *neutral* IPC extensions: a connection registers a method with `extension.register`, owns it until it disconnects or calls `extension.unregister`, and the daemon routes `extension.invoke` calls back to the owner. It assigns no meaning to a method and knows nothing about the optional Paseo integration, whose process data lives under the selected home (`$ALP_HOME/integrations`, `$ALP_HOME/logs/integrations`).

What survives a crash of the alpd process, when `session.prompt` is acknowledged, how long a `clientMessageId` is honoured, and what is not covered (power loss, disk failure): [ALPD §66](../../plans/reference/ALPD.md). `tests/crash-recovery.test.js` kills a real alpd at each point with a fake provider.

Fork recovery keeps an exact journal-attempt completion witness on the source after the target timeline, record, placement and attachment pins finish. Retention keeps an applied fork's source until its journal becomes terminal, and keeps its target until that witness is durable. A lost final journal marker can therefore be repaired without recreating a target that retention removed. The witness follows the existing journal-aware cleanup rules; an applied entry can retain its source until a retry or restart repairs the marker.

Pre-upgrade applied forks have no recovery version. A present target with matching stable fork provenance can finish recovery; an absent target cannot distinguish an interrupted creation from prior retention deletion. That ambiguous legacy case stays applied and returns `persistence_failed` instead of recreating history. Newly prepared forks still recover automatically when interrupted before their target record exists. These writes cover process crashes, with the existing no-fsync/power-loss limitation.

Build: `npm run build --workspace=@anhlp/alp-daemon`. Test: `npm run test --workspace=@anhlp/alp-daemon`.

Public imports use the package root and its explicitly exported subpaths. See [architecture, provider extension, compatibility and release instructions](../../docs/modular-monorepo.md).
