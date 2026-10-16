# ALP 0.0.0-beta.1 — release notes

> Published on 2026-10-16 as the GitHub prerelease
> [v0.0.0-beta.1](https://github.com/phucanh08/alp/releases/tag/v0.0.0-beta.1); there the links are
> absolute, at the tag. Scope, gate and post-publish results: [beta-scope.md](beta-scope.md) §6.4.

ALP's first beta: the `alp` CLI and its per-user daemon `alpd`, which run filesystem-defined
agent teams on Codex CLI and Claude Code, and an optional plugin that shows them in Paseo and
serves `alp web` on this machine.

## Install

```sh
npm install -g @anhlp/alp@beta                 # CLI and alpd
npm install -g @anhlp/alp-paseo@beta           # optional: alp web and the Paseo plugin
paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"   # optional: in Paseo
```

In this beta, add the plugin to Paseo by its installed path as above: `paseo plugin add
npm:@anhlp/alp-paseo@beta` fails ([#111](https://github.com/phucanh08/alp/issues/111)).
The npm tags `beta` and `latest` both point at `0.0.0-beta.1`, so a plain
`npm install -g @anhlp/alp` installs the beta too. Step by step, including signing in
to a provider, the daemon and `alp web`: [beta-install.md](beta-install.md).

**Coming from 0.10.0?** 0.10.0 has no `alp backup`. Stop alpd (`alp daemon stop`) and copy
`$ALP_HOME` (default `~/.alp`) before you upgrade. `alp web` moved out of `@anhlp/alp` into
`@anhlp/alp-paseo`, and the Paseo plugin's npm name changed from `alp-paseo-plugin` to
`@anhlp/alp-paseo` (the old name is deprecated): `paseo plugin remove alp-provider`, then
install and add the new one as above. On its first start the beta migrates alpd's state
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

- Real Codex and Claude runs were made on these exact release tarballs, on macOS only
  (beta-scope §6.4). After publishing, the packages installed from npm were checked again on
  macOS: integrity against the release manifest, a clean install with and without a tag, and a
  short smoke run with Codex, the Paseo plugin (added by path, see below) and `alp web`.
- macOS is the primary test platform (beta-scope D7). Runs with real Codex and Claude on the
  release tarballs are a release condition on macOS only. On Linux, the hermetic CI suites and
  fake-provider rehearsals on the same tarballs pass; real-provider runs there are done when
  possible. Windows stays experimental.
- CI runs the full hermetic suites (`core`, `paseo`) on Ubuntu (Node 22 and 24) and on macOS
  (Node 24).
- Windows: no login service; tests that use a fake Codex or POSIX processes are skipped there
  (for example backup and restore through alpd); no CI lane runs the whole suite.
- Client SDK smoke tests (browser, Metro, tarball) are not in CI.
- `npm audit --omit=dev` on the repository and `npm audit` on a fresh install of the eight
  tarballs report 0 vulnerabilities at the release commit. The repository's own dev tree still
  has a react-native/jest chain that no package ships. `npm audit` cannot see code that
  `@anthropic-ai/claude-agent-sdk` bundles inside its own package.
- A backup does not hold Codex or Claude threads, which those tools keep; a restore on another
  machine does not bring their native context.
- `alp web` is Paseo's web app at a pinned commit with ALP's patches. What Paseo has and ALP
  has not built yet (terminals, commit and push, worktrees from the app, voice, …) says it is
  in development.
- `alp web`: a very long agent message with many email addresses or `mailto:` links can hang the
  browser tab (linkify-it 2.2.0 in Paseo's web app; GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm).
  It affects only the page on this machine; upstream Paseo has not fixed it yet. Planned fix:
  before `0.0.0-beta.2` or 2026-11-15, whichever comes first.
- In Paseo and `alp web`, a session on Claude shows the assistant's text only once each message
  is complete; Codex sessions stream as they go. Stop still works. To be fixed in a later beta
  ([#107](https://github.com/phucanh08/alp/issues/107)).
- `paseo plugin add npm:@anhlp/alp-paseo@beta` fails with `Could not resolve type dependency
  "@getpaseo/relay/e2ee"`: Paseo checks the type declarations the plugin ships, and they import
  Paseo packages that are only peer dependencies. Install the plugin with npm and add it by path
  (see Install). To be fixed in `0.0.0-beta.2`
  ([#111](https://github.com/phucanh08/alp/issues/111)).
- Older versions (`@anhlp/alp` 0.3.0–0.10.0, the other `@anhlp/alp-*` 0.10.0) and the old
  plugin name `alp-paseo-plugin` are deprecated on npm; they still install, with a warning.

## Checksums

The release attaches the eight `*-0.0.0-beta.1.tgz` tarballs, `SHA256SUMS` and
`release-manifest.json`. Check a download with `shasum -a 256 -c SHA256SUMS` (macOS) or
`sha256sum -c SHA256SUMS` (Linux).

Release commit `2230aa5876485cec36b2ec118d32612f454564a7`. `SHA256SUMS` (its own SHA-256 is
`523cf5cc35c67b4ff6833ecff6828339239c38c5c67835c6dba958c84819b81c`):

```text
d9ef470693790929f90989f9224b5a35bc12cc2966f22d38e29820aa3b39118a  anhlp-alp-0.0.0-beta.1.tgz
7a3eaad19a17874a129645b061534f46898f3d727df12a042c19774b8b55bd6e  anhlp-alp-cli-0.0.0-beta.1.tgz
b0b7808f0429442d25de8b4975daff100242c8461a52fa898a75ecb3d370c10f  anhlp-alp-client-0.0.0-beta.1.tgz
8cb8413d66aa6931762ca0a0517acfb877891bdbce1d0d361a236d5902308dd4  anhlp-alp-core-0.0.0-beta.1.tgz
1cfc08c45fd3129d495d08dbd1684b0b91be8fe23395de71b644f3be1fd93fac  anhlp-alp-daemon-0.0.0-beta.1.tgz
ed9bb789596c05bf9cb7957b9793d0c514846219f5ece67857347778531eb634  anhlp-alp-paseo-0.0.0-beta.1.tgz
57eb63ee488f2d33eb841ce941bea6e3aceed3f35fe259673594b8738d1b8f4c  anhlp-alp-protocol-0.0.0-beta.1.tgz
36155728dc360bd0037478283c1d9053bd74360ca6e0e5f0e1f4a513bd3442ea  anhlp-alp-runtime-0.0.0-beta.1.tgz
```

## More

- [Install, upgrade, back up and remove](beta-install.md)
- [Backups, restores, upgrades and recovery](data-recovery.md)
- [Paseo plugin](../../integrations/paseo/README.md) · [plugin internals](paseo-plugin.md)
- [Phở and Cafe teams](team-workflow.md) · [agent library](agent-library.md) ·
  [Codex only](codex-only.md)
- [Beta scope, gate and release checklist](beta-scope.md) (Vietnamese)
