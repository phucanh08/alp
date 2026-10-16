# ALP 0.0.0-beta.1 — release notes (DRAFT)

> **DRAFT — not released.** Nothing in this file says the beta is published or that its gate
> passed. Source of truth for scope and gate: [beta-scope.md](beta-scope.md). Before this text
> becomes the GitHub prerelease notes (`--notes-file`, beta-scope §7.6), work through the
> editor's checklist at the end and remove it.

ALP's first beta: the `alp` CLI and its per-user daemon `alpd`, which run filesystem-defined
agent teams on Codex CLI and Claude Code, and an optional plugin that shows them in Paseo and
serves `alp web` on this machine.

## Install

```sh
npm install -g @anhlp/alp@beta                 # CLI and alpd
npm install -g @anhlp/alp-paseo@beta           # optional: alp web and the Paseo plugin
paseo plugin add npm:@anhlp/alp-paseo@beta     # optional: in Paseo
```

Always name the beta (`@beta`, or exactly `@0.0.0-beta.1`): a plain `npm install -g @anhlp/alp`
installs the older `0.10.0` while that is still `latest`. Step by step, including signing in
to a provider, the daemon and `alp web`: [beta-install.md](beta-install.md).

**Coming from 0.10.0?** 0.10.0 has no `alp backup`. Stop alpd (`alp daemon stop`) and copy
`$ALP_HOME` (default `~/.alp`) before you upgrade. `alp web` moved out of `@anhlp/alp` into
`@anhlp/alp-paseo`, and the Paseo plugin's npm name changed from `alp-paseo-plugin` to
`@anhlp/alp-paseo`: `paseo plugin remove alp-provider`, then
`paseo plugin add npm:@anhlp/alp-paseo@beta`. On its first start the beta migrates alpd's state
and saves a `pre-migrate-v1-v2-*` backup first. Full steps:
[upgrading from 0.10.0](beta-install.md#upgrading-from-0100-or-earlier).

## Packages

All at `0.0.0-beta.1`, on the npm tag `beta`; internal dependencies are pinned to that version.

| Package | In this beta | Contents |
|---|---|---|
| `@anhlp/alp` | Published | `alp` and `alpd`; no Paseo code |
| `@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli` | Published | installed with `@anhlp/alp` and the plugin |
| `@anhlp/alp-paseo` | Published | Paseo plugin, `alp web` (Paseo's web app, Apache-2.0, with ALP's patches), `alp-web-integration` |
| `@anhlp/alp-gateway` | Not published (deferred) | — |
| `@anhlp/alp-web` (`apps/web`) | Not published (deferred) | — |
| `@anhlp/alp-tui` | Not published | — |

## Support

| | Supported | Experimental | Not supported |
|---|---|---|---|
| OS | Linux, macOS | Windows: CLI and a local alpd; no `alp daemon install`; CI runs only a daemon/IPC subset | — |
| Node.js | 22 (22.12 or later), 24 | 26 (local evidence only) | 20 (end of life 2026-04-30) |
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (full access; its read-only is only an instruction in the prompt) | — |
| Paseo host | `>=0.11.1 <0.12.0` | — | 0.12 and later |

## What is in the beta

**Included** (covered by the beta's acceptance gate):

- CLI and alpd: `init`, `upgrade`, `setup`, `doctor`, `daemon start|stop|restart|status`, `run`,
  `ps`, `top`, `attach`, `send`, `questions`, `answer`, `log`, `interrupt`, `board`,
  `tasks`/`task`, `formula`, `verify`, `recall`, `pause`/`resume`, `backup`/`restore`.
- Teams Phở and Cafe, your own teams, permission profiles and permission questions (Allow once /
  Always allow / Deny), worktrees and `alp_merge`, pausing at usage limits, recovery after alpd
  restarts or crashes.
- Paseo plugin: the `alp` provider, the Tasks panel, Settings → ALP, the ALP project panel, and
  keeping alpd running.
- `alp web` on this machine only: loopback (port 7433), with a token, through
  `alp-web-integration`.

**Experimental** (documented and labelled, outside the acceptance gate):

- ACP and Antigravity providers; `alp acp` for editors.
- Relay pairing with Paseo's app on another device (`relay.paseo.sh`); off by default.
- The `@anhlp/alp-client/portable` and `/websocket` entries for browsers and React Native.
- `alp daemon install` (launchd, systemd).
- Windows.

**Deferred** (not in this beta):

- `@anhlp/alp-gateway`, the plugin's remote mode (`ALP_GATEWAY_URL`), Caddy/nginx examples.
- The standalone web app `apps/web`; the TUI.
- Reading and writing the library remotely; git, files and terminals in the web app.
- React Native on Hermes or real devices.
- Automated publishing.

## Known issues

- Evidence with real providers so far comes from older opt-in end-to-end runs on the source
  tree, not on the published packages. The beta's gate adds real-provider runs on the release
  tarballs (beta-scope §6.1).
- macOS is the primary test platform (beta-scope D7). Runs with real Codex and Claude on the
  release tarballs are a release condition on macOS only. On Linux, the hermetic CI suites and
  fake-provider rehearsals on the same tarballs pass; real-provider runs there are done when
  possible. Windows stays experimental.
- CI runs the full hermetic suites (`core`, `paseo`) on Ubuntu (Node 22 and 24) and on macOS
  (Node 24).
- Windows: no login service; tests that use a fake Codex or POSIX processes are skipped there
  (for example backup and restore through alpd); no CI lane runs the whole suite.
- Client SDK smoke tests (browser, Metro, tarball) are not in CI.
- `npm audit` reported 21 existing vulnerabilities (react-native/jest chain, ajv); they have
  not been triaged again yet.
- A backup does not hold Codex or Claude threads, which those tools keep; a restore on another
  machine does not bring their native context.
- `alp web` is Paseo's web app at a pinned commit with ALP's patches. What Paseo has and ALP
  has not built yet (terminals, commit and push, worktrees from the app, voice, …) says it is
  in development.
- `alp web`: a very long agent message with many email addresses or `mailto:` links can hang the
  browser tab (linkify-it 2.2.0 in Paseo's web app; GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm).
  It affects only the page on this machine; upstream Paseo has not fixed it yet.
  <!-- Keep only if T6/S1 accepts this risk for the beta; if it is fixed, remove this item. -->
- `npm install -g @anhlp/alp` without a tag installs `0.10.0` until `latest` moves to the beta.
  The old plugin name `alp-paseo-plugin` stays at `0.10.0`.

## Checksums

The release attaches the eight `*-0.0.0-beta.1.tgz` tarballs, `SHA256SUMS` and
`release-manifest.json`. Check a download with `shasum -a 256 -c SHA256SUMS` (macOS) or
`sha256sum -c SHA256SUMS` (Linux).

<!-- Paste SHA256SUMS here when the tarballs are built (beta-scope §7.2). -->

## More

- [Install, upgrade, back up and remove](beta-install.md)
- [Backups, restores, upgrades and recovery](data-recovery.md)
- [Paseo plugin](../../integrations/paseo/README.md) · [plugin internals](paseo-plugin.md)
- [Phở and Cafe teams](team-workflow.md) · [agent library](agent-library.md) ·
  [Codex only](codex-only.md)
- [Beta scope, gate and release checklist](beta-scope.md) (Vietnamese)

---

## Editor's checklist (remove before publishing)

State on 2026-10-16, read from the working tree; each item belongs to another task. "In the
working tree" means changed but not committed or released.

| Item | State | Needed for these notes |
|---|---|---|
| T1 version `0.0.0-beta.1` in manifests and lockfile | in the working tree: the 8 packages say `0.0.0-beta.1` | install commands resolve |
| T2 `apps/gateway` `"private": true` | in the working tree | "not published" row is true |
| T3 `engines.node` `>=22.12` | in the working tree for the 8 packages (gateway keeps `>=20`) | Support table matches npm |
| T6 / S1 `npm audit` triage | local triage complete; F1/F2 fixed; F3 accepted under scope D5 | rerun on the release SHA; retain the F3 known issue |
| Plugin's React and React Native peers optional (`peerDependenciesMeta`) | in the working tree; docs updated | re-check if it is reverted |
| Gate H1–H5, A5, R1–R7 on the release SHA (beta-scope §6) | not run; harness `scripts/beta-acceptance-{cli,web,r7}.mjs` in the working tree (T10), referenced in beta-scope §6.3 | add accepted R1–R7 issues to Known issues |
| Q1–Q5 after publishing (beta-scope §7.5) | not run | drop or keep the `latest` known issue (D2) |
| `paseo plugin add npm:<scoped name>@beta`, `paseo provider models alp` | not tried with a published package; Q3/W2 try them | install commands |
| Checksums | tarballs not built | paste `SHA256SUMS` |

Links here are relative to `docs/alp/`; on GitHub's release page, make them absolute
(`https://github.com/phucanh08/alp/blob/<tag>/docs/alp/…`).
