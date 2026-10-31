# ALP — next beta after 0.0.1-beta.6 (unreleased) — release notes

Prepared 2026-10-31 (task t-1807). Not published; the version bump and publishing are the owner's steps.

- **Breaking: the release is the ALP bundle, not one executable.** The GitHub release archives
  (`alp-<version>-<os>-<arch>.tar.gz`, `alp-<version>-windows-x64.zip`) now hold ALP's npm install
  (`@anhlp/alp-cli` and its dependencies) beside the official Node release it runs on (Node 24 LTS,
  checksum-pinned), with a launcher, as Paseo ships its daemon on Electron's Node. It still needs no
  Node on the machine. `bun build --compile` is gone, and with it every Bun-only special case: the
  embedded-asset cache `<ALP_HOME>/cache/<version>/`, the script-path guard, `BUN_BE_BUN`, the
  Windows fd writer and embedded `conpty.dll`, and the Claude SDK registration of beta.6. The Claude
  Agent SDK loads from `node_modules`; its native `claude` packages are not shipped, since ALP runs
  your own `claude`. See [binary-install.md](binary-install.md).
- **Layout:** `install.sh` puts the bundle in `~/.alp/app/<version>/`, points `~/.alp/app/current`
  at it and links `~/.alp/bin/alp` to `~/.alp/app/current/bin/alp` (`--system`:
  `/usr/local/lib/alp/app` and `/usr/local/bin/alp`; new `--root`). On Windows, `install.ps1` uses
  `%LOCALAPPDATA%\Programs\alp\app\<version>`, a junction `app\current` and `alp.cmd` (new `-Root`).
- **`alp update`** installs the new version beside the running one and switches `app/current`
  atomically; the previous version stays until the next update. Services (`alp daemon install`)
  and alpd's install record name `app/current`, never a version directory.
- **Upgrading from 0.0.1-beta.5/6 (single file): rerun the installer once.** Their `alp update`
  replaces one file and cannot install the bundle. `curl -fsSL
  https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh` (Windows: `install.ps1`),
  then `alp daemon restart`. Services and MCP entries written by the single-file build keep working;
  `<ALP_HOME>/cache/` and `~/.alp/share/doc/alp` may be deleted.
- **Sizes:** an archive is about 50 MB (darwin-arm64 51.8 MB), about 210 MB unpacked, most of it Node.
- **npm: `@anhlp/alp` is now a thin wrapper around `@anhlp/alp-cli`** (pinned to the same
  version) and runs on your Node (22.12 or later): `npm install -g @anhlp/alp@beta`. The five
  platform packages `@anhlp/alp-<os>-<arch>` are retired and will not be published; a release is 8
  tarballs. `release:pack` no longer takes `--binaries`/`--binaries-release`, and
  `release-acceptance.yml` no longer takes `binaries_run`/`binaries_release`. CI smokes the wrapper
  with `npm install -g` (`scripts/npm-wrapper-smoke.mjs`). See [binary-install.md](binary-install.md#npm-packages).

# ALP 0.0.1-beta.6 — release notes

Prepared 2026-10-30 (task t-693e). Not published yet; publishing is the owner's step (t-36f6).
`0.0.1-beta.6` replaces beta.5 on both channels, with one version and one main SHA:

- **Fixed: every Claude session failed in the beta.5 executable** with
  `Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /$bunfs/root/alp`. The runtime
  imports the Claude Agent SDK by a computed name, which `bun build --compile` did not embed. The
  executable's entry now imports the SDK by its literal name and registers it
  ([binary-install.md](binary-install.md)). Codex sessions were not affected. If you installed the
  beta.5 executable, run `alp update` once beta.6 is published, or re-run `install.sh`.
- **New check:** `scripts/binary-smoke.mjs` runs a Claude turn (with a fake Claude) through the
  embedded SDK on all five binary-build platforms. Before this, no smoke started a Claude session,
  which is how beta.5 shipped broken.
- **npm:** beta.5 was never published to npm. `0.0.1-beta.6` is the first npm release of the
  `@anhlp/alp` launcher and its five platform packages, as described for beta.5 below. Their
  executables come from the GitHub release `v0.0.1-beta.6`.

The GitHub release `v0.0.1-beta.5` stays as it is. Everything else is as in beta.5 below.

# ALP 0.0.1-beta.5 — release notes

> Superseded: the npm part of beta.5 below was never published. Read `0.0.1-beta.5` npm packages and the `v0.0.1-beta.5` release they pack from as `0.0.1-beta.6` / `v0.0.1-beta.6` (see above).

Prepared 2026-10-30 (task t-1e02). This is the first version shipped two ways, with the same
version number in both:

- **npm** (t-cd7f): `@anhlp/alp` is now a small launcher (plain Node, no dependencies, no
  postinstall). npm installs the ALP executable for the machine as one optional dependency,
  `@anhlp/alp-<os>-<arch>` (darwin-arm64, darwin-x64, linux-x64, linux-arm64 with glibc, win32-x64).
  That executable is byte for byte the one in the GitHub release `v0.0.1-beta.5` (built from
  `2b63a7a`), checked against that release's `SHA256SUMS` ([binary-install.md](binary-install.md#npm-packages)).
  There are thirteen npm packages at `0.0.1-beta.5` under the `beta` dist-tag: the seven JavaScript
  packages (`@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli`, `-paseo`), the five
  platform packages, then `@anhlp/alp` (`npm install -g @anhlp/alp@beta`). musl (Alpine) and other
  unsupported platforms use the JavaScript CLI: `npm install -g @anhlp/alp-cli@beta` (uninstall
  `@anhlp/alp` first, because both provide `alp`).
- **Standalone executable**: a GitHub release `v0.0.1-beta.5` with archives for macOS and Linux
  (glibc), arm64 and x64, `SHA256SUMS`, build provenance and `install.sh`
  ([binary-install.md](binary-install.md)). The release is a normal release, not a prerelease, so
  `releases/latest/download/install.sh` installs it.

`release-binaries.yml` only creates the draft; the owner reviews it and publishes it by hand, and
publishes npm separately. Nothing else changes from `0.0.1-beta.4` below.

Known issue (npm install): the beta.5 executables predate the npm-aware `alp update` (t-cd7f, after
`2b63a7a`). In an npm install, update with npm (`npm install -g @anhlp/alp@beta`), not `alp update`.
`alp update` would replace the file inside `node_modules/@anhlp/alp-<os>-<arch>/` behind npm's back.
From the next executable release on, `alp update` prints the npm command instead.

# ALP 0.0.1-beta.4 — release notes

Prepared 2026-10-27. Publication and acceptance results will be recorded in
[beta-scope.md](beta-scope.md) §13. Install after publication with:

```sh
npm install -g @anhlp/alp@beta
paseo plugin add npm:@anhlp/alp-paseo@beta
```

All eight public packages use `0.0.1-beta.4`, with internal dependencies pinned to that version.
The Paseo compatibility range is now `>=0.11.1 <1.0.0` (beta.3 declared `<0.13.0`). macOS and Linux support,
Node 22.12+ and 24, and the experimental status of Windows and remote features are unchanged.
Back up your ALP home before upgrading; see [beta-install.md](beta-install.md).

Changes since `0.0.1-beta.3`:

- **Remote terminals** (issue #121 H, off by default): a real PTY shell on the host, as the account
  that runs alpd (a workspace is not a sandbox), for the web app through `alp-gateway` (credential
  permission `terminal.exec`, never a default) and, separately opted in, Paseo app devices. Turn on
  with `alp terminal allow --yes` ([beta-install.md](beta-install.md#remote-terminals-optional-off-by-default)).
- **New optional dependency** `node-pty@1.2.0-beta.15` (MIT, Microsoft, exact pin) in `@anhlp/alp`,
  `-cli`, `-daemon` and `@anhlp/alp-paseo`: prebuilt binaries in its tarball, loaded only for a
  terminal, about 27 MB unpacked. It is optional, so an install where it fails still works, without
  terminals. Windows is not supported.
- **New `alp web`** (epic t-55ce): `alp web` now opens ALP's own web app (`apps/web`) through the
  CLI's `alp-web` service, shipped in `@anhlp/alp` and `@anhlp/alp-cli` (`dist/alp-web.js`, the app
  in `dist/alp-web/`, `THIRD-PARTY-NOTICES.txt`); no Paseo plugin is needed. One listener on
  `127.0.0.1` at `web.port` (default 7433, then the next nine ports) serves the app and an embedded
  ALP gateway; `alp-web` keeps alpd running (`ALP_SUPERVISE=0` opts out). `alp web --print` prints
  `http://127.0.0.1:<port>/#token=alpgw1.…` instead of opening it. The gateway stays private and
  unpublished (bundled into the CLI): still eight tarballs. Details:
  [web.md](web.md#31-alp-web-trên-máy-này-alp-web), [beta-install.md](beta-install.md#alp-web-on-this-machine).
  - **Credential:** the token is a gateway credential in `~/.alp/web/credentials.json`, a store of
    alp-web's own that `alp-gateway credential list/create` do not see. The page drops it from the
    address and keeps it only in the tab's session storage; a reload reuses it.
  - **`alp web rotate`:** stops alp-web, replaces the credential (the old token is revoked and open
    pages lose access) and starts it again; open the new link from `alp web`.
  - **Permissions:** `session.read`/`write`, `project.read`/`write` and `workspace.write`.
    `files.read`, `attachments.write`, `session.team.write` and `terminal.exec` only when listed in
    the `web.permissions` setting; a list with an entry that is not a permission is ignored, with a
    warning, and a malformed entry (not a lowercase name with dots) makes the whole `settings.json`
    invalid: alpd, alp-web and the Paseo integration each ignore all of it and log
    `ALP_SETTINGS_INVALID`. Settings apply when alp-web starts.
  - **Workspaces:** alpd's project registry plus the folder `alp web` ran in when it started the
    service, if that folder is an ALP project. New projects reach open pages: the grant is updated
    and connections close with 4403, then reconnect. Sessions recorded under a symlinked project
    root (`/var/…` instead of `/private/var/…`) do not show.
  - **Upgrade:** the first `alp web` stops a Paseo integration from before the rename that still
    holds `integrations/web.lock` (SIGTERM, only to a proven same-user, same-boot owner; never on
    Windows) and copies its token and server id once to `~/.alp/paseo.json` when that file does not
    exist, so paired devices keep working.
- **The Paseo integration is renamed `paseo`** (`@anhlp/alp-paseo`): `integrations/paseo.lock`,
  `~/.alp/paseo.json`, and a port the system picks (never `web.port`). It keeps the bridge, the
  relay and `alp web pair`, which prints the token in `paseo.json` as the password. For one release
  `alp-web-integration` remains an alias of `alp-paseo-integration`, `ALP_WEB_INTEGRATION` is read
  after `ALP_PASEO_INTEGRATION` for this integration only, and a home registered with
  `integrations/web.json` still starts it.
- **Paseo's web app removed** (t-55ce.3): `@anhlp/alp-paseo` no longer ships ALP's patched build of
  Paseo's web app (`server/dist/web-app`, with its `NOTICE.txt` and third-party notices), and the
  repository no longer keeps its patches (`paseo-web/`), its build (`npm run build:web`,
  `scripts/build-paseo-web.mjs`) or its CI smoke. The integration's local listener answers plain
  HTTP requests with 404 and keeps only the token-guarded Paseo socket that `daemon.get_status`
  reports. The bridge now starts whenever the integration runs; before, it started only when the
  web app was built beside it. Pair Paseo's app on another device with `alp web pair`: open the link it
  prints on that device and give the password it prints. The plugin ships Paseo's licence as
  `LICENSE.paseo.txt` for the code it takes from Paseo. `createWebServer` takes `gateway`; `app`
  (its `dir` ignored) is kept for one release, and `webAppDir` is gone.
- **Windows: untested.** CI runs alp-web's tests on Linux and macOS only, and macOS remains the
  primary platform. A trial on Windows CI found writes of the credential file failing now and then
  with `EPERM`, which can make `alp web rotate`, a workspace grant update or a start that replaces the token fail. On Windows alp never
  stops a running alp-web or the old Paseo integration for you: `alp web rotate` and the upgrade
  takeover refuse while one runs. End the process whose pid `~/.alp/web.json` names
  (`taskkill /PID <pid>`), then run the command again. Ending it this way is not a clean shutdown;
  the next start reclaims its lock.

# ALP 0.0.1-beta.3 — release notes

> Published 2026-10-20 on the npm tags `beta` and `latest` as the GitHub prerelease
> [v0.0.1-beta.3](https://github.com/phucanh08/alp/releases/tag/v0.0.1-beta.3) (release commit
> `18aa65f`; results in [beta-scope.md](beta-scope.md) §12.5). The `0.0.0-beta.2` and
> `0.0.0-beta.1` notes follow below, unchanged.

The third beta of the `alp` CLI and its per-user daemon `alpd`, and of the optional Paseo plugin
that also serves `alp web` on this machine. Its main reason is **Paseo 0.12**: the plugin of
`0.0.0-beta.2` and earlier declares Paseo `<0.12.0`, and Paseo 0.12.0 refuses to load it
(`Plugin "alp-provider" requires Paseo >=0.11.1 <0.12.0. Your daemon is 0.12.0`). This beta
supports **Paseo 0.11.x and 0.12.x** (`>=0.11.1 <0.13.0`). The packages, platforms and support
levels are otherwise the same as in `0.0.0-beta.2`.

The version moves from `0.0.0-beta.N` to `0.0.1-beta.3`. By semver it sorts above every
`0.0.0-beta.*` and still below the old `0.10.0`, so name the beta when you install (below).

## Install

```sh
npm install -g @anhlp/alp@beta                 # CLI and alpd
paseo plugin add npm:@anhlp/alp-paseo@beta     # optional: the Paseo plugin (Paseo 0.11.x or 0.12.x)
npm install -g @anhlp/alp-paseo@beta           # optional: alp web outside Paseo
```

Coming from `0.0.0-beta.2` or `0.0.0-beta.1`: `npm install -g @anhlp/alp@beta` (and
`@anhlp/alp-paseo@beta` if you have it), then `alp daemon restart`; in Paseo,
`paseo plugin remove alp-provider` and add it again as above. Do this **before or together with**
moving Paseo to 0.12: a `0.0.0-beta.2` (or earlier) plugin only runs with Paseo `<0.12.0`. There
is no state migration between the betas. Coming from 0.10.0: as in the beta.1 notes below, and
[upgrading from 0.10.0](beta-install.md#upgrading-from-0100-or-earlier).

## Packages

All at `0.0.1-beta.3`, on the npm tag `beta`; internal dependencies are pinned to that version.
The same eight packages as before: `@anhlp/alp`, `@anhlp/alp-protocol`, `-core`, `-runtime`,
`-client`, `-daemon`, `-cli` and `@anhlp/alp-paseo`. `@anhlp/alp-gateway`, `@anhlp/alp-web`
(`apps/web`) and `@anhlp/alp-tui` are still not published.

## What changed since 0.0.0-beta.2

In the published packages:

- **Paseo 0.12** (PR #166): the plugin manifest (`paseo-plugin.json` `requirements.paseo`) and
  the `@getpaseo/*` peers declare `>=0.11.1 <0.13.0`. Between Paseo 0.11.4 and 0.12.0 the plugin
  SDK and relay are unchanged and the client and protocol changes are additive. CI checks both
  bounds (Paseo 0.11.1 and the latest release) and that the manifest and the peers stay equal.
- **Claude streams into Paseo and `alp web`** (PR #133, fixes
  [#107](https://github.com/phucanh08/alp/issues/107)): a Claude session shows the assistant's
  text as it is written, not only once each message is complete.
- **`alp --version`** prints the package version (PR #158, #152).
- **Agent teams in long runs:**
  - a finished assignment wakes its parent even after many earlier wakes (PR #130, #115);
  - delegation budgets are per root session and separate for implementation and advisor
    assignments, so a run no longer runs out of reviewers; `alp_issue` and `alp_skill` approvals
    return at once and their decision arrives as mail (PR #134, #137; #114, #116);
  - a user message ends main's own pending `alp_ask`; a `wait: true` call whose turn ended
    reports `running`, not `canceled` (PR #137);
  - a root session stopped by a provider usage limit continues by itself once the limit lifts,
    also after an alpd restart (PR #141, #139); an explicit "usage not allowed" from Codex keeps
    the pause (PR #160, #149).
- **alpd lifecycle:** starting and stopping alpd no longer race each other into a second daemon
  or a lost stop (PR #157, #146); startup errors reach the client that started it.
- **Paseo plugin:** a session removed and added back re-attaches; usage reaches Paseo; diffs
  that start with `+++` show correctly (PR #138, #117). In remote mode the settings open library
  entries in a read-only viewer (PR #161, #147).
- **alpd library and workspace files** (PR #140, #118): `library.save`, `delete`, `duplicate` and
  `rename` take a `policy`, and alpd refuses project-data library writes it cannot keep safe
  (`library_policy`); workspace search honours `.gitignore`.
- **Docs:** registering `alp web` from a plugin that Paseo installed from `npm:` is not
  supported; use the npm-installed CLI (PR #162, #154).

In the repository only: `@anhlp/alp-gateway` credential grants and the client limits that use
the above (PR #140), and test and CI fixes (PRs #131, #136, #156, #159, #163).

## Support

Linux and macOS; Node.js 22 (22.12 or later) and 24; Codex CLI and Claude Code; Paseo
`>=0.11.1 <0.13.0` (0.11.x and 0.12.x). Plugin releases `0.0.0-beta.2` and earlier: Paseo
`>=0.11.1 <0.12.0` only. Windows, Node.js 26, ACP and Antigravity stay experimental.

## What is in the beta

Included, Experimental and Deferred are as in `0.0.0-beta.1` (below).

## Known issues

- Real Codex and Claude runs on the release tarballs are a release condition on macOS only
  (beta-scope D7). On Linux, the hermetic CI suites and fake-provider rehearsals on the same
  tarballs pass; real-provider runs there are done when possible. Windows stays experimental.
- `0.0.0-beta.2` and earlier stay on npm unchanged and do not load in Paseo 0.12 (above).
- Windows: no login service; tests that use a fake Codex or POSIX processes are skipped there;
  no CI lane runs the whole suite.
- Client SDK smoke tests (browser, Metro, tarball) are not in CI.
- A backup does not hold Codex or Claude threads, which those tools keep; a restore on another
  machine does not bring their native context.
- `alp web` is Paseo's web app at a pinned commit with ALP's patches. What Paseo has and ALP
  has not built yet (terminals, commit and push, worktrees from the app, voice, …) says it is
  in development.
- Older versions (`@anhlp/alp` 0.3.0–0.10.0, the other `@anhlp/alp-*` 0.10.0) and the old
  plugin name `alp-paseo-plugin` are deprecated on npm; they still install, with a warning.

## Checksums

The release attaches the eight `*-0.0.1-beta.3.tgz` tarballs, `SHA256SUMS` and
`release-manifest.json`. Check a download with `shasum -a 256 -c SHA256SUMS` (macOS) or
`sha256sum -c SHA256SUMS` (Linux). Release commit `18aa65f0844bb89abb360e590e3e4146bad1b0db`.
`SHA256SUMS` (its own SHA-256 is `c6fa00c29172486e1934e032a117be7f595ccdd1f5a3d2436bd0930dd72e8eee`):

```text
cfa0fe03c849f884c4ee0b98cedb47d544450e11d08d8c2554cbdefb33605442  anhlp-alp-0.0.1-beta.3.tgz
60e44ab928886eec4697b4795e3dbeb7751af9e7c172d7d002ded0e1f8fd4c9e  anhlp-alp-cli-0.0.1-beta.3.tgz
df283221260e4119d30ef77d2be213daaa020783fcd64ce074c7ef85ddeadb19  anhlp-alp-client-0.0.1-beta.3.tgz
28d5e24acab9dd777cfb38566669a8bf21f9bda0947208a3579e47beb3d051d8  anhlp-alp-core-0.0.1-beta.3.tgz
6c51c22465c6ec7dfe9a4c7648f9c4075283a84b8323b667a313dd5319fe30a9  anhlp-alp-daemon-0.0.1-beta.3.tgz
bc10d780872f6b19051642ba968dce8b35316760574dc31ee56ddbb8d36a415b  anhlp-alp-paseo-0.0.1-beta.3.tgz
4f0849abba917f4e6ffbaaaf60100ff597a21956d6797f988cc7b012e6cc54df  anhlp-alp-protocol-0.0.1-beta.3.tgz
7dffc3c15584de9868046ae5b804c0f15aee3442c8d74dee88a6df9f1631513c  anhlp-alp-runtime-0.0.1-beta.3.tgz
```

Acceptance for this beta ran real Claude Code on macOS (CLI, Paseo 0.11.4 and Paseo 0.12.0);
the real-Codex rows were skipped for this beta by the owner's decision.

---

# ALP 0.0.0-beta.2 — release notes

> Published 2026-10-18 on the npm tags `beta` and `latest` as the GitHub prerelease
> [v0.0.0-beta.2](https://github.com/phucanh08/alp/releases/tag/v0.0.0-beta.2) (release commit
> `1b16b14`; results in [beta-scope.md](beta-scope.md) §11.6). The `0.0.0-beta.1` notes follow
> below, unchanged.

The second beta of the `alp` CLI and its per-user daemon `alpd`, which run filesystem-defined
agent teams on Codex CLI and Claude Code, and of the optional plugin that shows them in Paseo and
serves `alp web` on this machine. The packages, platforms and support levels are the same as in
`0.0.0-beta.1`.

## Install

```sh
npm install -g @anhlp/alp@beta                 # CLI and alpd
paseo plugin add npm:@anhlp/alp-paseo@beta     # optional: the Paseo plugin
npm install -g @anhlp/alp-paseo@beta           # optional: alp web outside Paseo
```

From this beta Paseo adds the plugin straight from npm
([#111](https://github.com/phucanh08/alp/issues/111)); the install-by-path workaround of
`0.0.0-beta.1` is no longer needed. Coming from `0.0.0-beta.1`: `npm install -g
@anhlp/alp@beta` (and `@anhlp/alp-paseo@beta` if you have it), then `alp daemon restart`; in
Paseo, `paseo plugin remove alp-provider` and add it again as above. There is no state
migration between the two betas. Coming from 0.10.0: as in the beta.1 notes below, and
[upgrading from 0.10.0](beta-install.md#upgrading-from-0100-or-earlier).

The npm tags `beta` and `latest` both point at `0.0.0-beta.2`, so a plain `npm install -g
@anhlp/alp` installs this beta too.

## Packages

All at `0.0.0-beta.2`, on the npm tags `beta` and `latest`; internal dependencies are pinned to
that version.
The same eight packages as in `0.0.0-beta.1`: `@anhlp/alp`, `@anhlp/alp-protocol`, `-core`,
`-runtime`, `-client`, `-daemon`, `-cli` and `@anhlp/alp-paseo`. `@anhlp/alp-gateway`,
`@anhlp/alp-web` (`apps/web`) and `@anhlp/alp-tui` are still not published.

## What changed since 0.0.0-beta.1

In the published packages:

- **Paseo plugin from npm** ([#111](https://github.com/phucanh08/alp/issues/111), PR #124):
  `@anhlp/alp-paseo` ships no type declarations, and its client code takes its Paseo types from
  the plugin SDK, so `paseo plugin add npm:@anhlp/alp-paseo@beta` installs. The release checks
  now install the packed plugin the way Paseo installs an `npm:` source (no peers) and run
  Paseo's own plugin compiler on it.
- **Paseo plugin, streaming:** the plugin no longer sends a whole assistant message again with
  each new piece, which showed repeated text in Paseo and `alp web` (PR #113).
- **Tool calls:** typed details (command, file edits, reads, searches, …) for each runtime, shown
  in Paseo, `alp acp` and the CLI's session output; Codex file changes, web searches and MCP
  calls are no longer dropped (PR #123).
- **alpd and its protocol** (additive; existing clients keep working), used by `apps/web`:
  - a root session is named from its first prompt, as Paseo does, and viewers are told
    (`session.updated` carries `title`);
  - `session.list` pages and searches, and questions can be watched across every session tree;
  - turn ends of root sessions can be watched, and a workspace's files searched;
  - `daemon.hello` carries the host's machine name;
  - `session.prompt` accepts inline images (PNG, JPEG, GIF, WebP; at most 8, 5 MiB each,
    11 MiB together) for Codex, Claude Code and ACP agents that accept images;
  - session token usage in Paseo's `AgentUsage` shape;
  - `files.read`: read-only access to a workspace's files;
  - typed tool-call details in `tool_call` items.
- **Fixes:**
  - a new session's preview names the team that `session.create` will actually run (before,
    a project without `workflow.mode` previewed Phở but ran the custom team);
  - `alp acp`: the custom team stays selectable in an editor's team picker;
  - alpd never runs a workspace's git through another spelling of the workspace path
    (case-insensitive file systems) or a PATH binary that links into the workspace;
  - `@anhlp/alp-core`'s declarations for `teamSources`/`resolveTeam` typecheck;
  - `alp web`: a very long agent message with many email addresses or `mailto:` links no longer
    hangs the browser tab (linkify-it 2.2.0; GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm; known
    issue in beta.1). ALP patch 0020 limits the text that auto-linking scans: in a message, a run
    of text over 2048 characters or a message over 32 KB is not auto-linked, and inline code over
    256 characters is not turned into a link. Trade-off: bare URLs and email addresses in such
    long text show as plain text; explicit markdown links still work
    ([#126](https://github.com/phucanh08/alp/pull/126)).

In the repository only (not in a published package, still deferred):

- `apps/web`, the standalone web app, reaches Paseo parity for chat, workspaces, New session,
  split panes, the tasks board (List/Board/Epics), History, image attachments, a context window
  meter, read-only workspace files (⌘P, Files panel) and library entries, and per-tool detail
  views (PRs #113, #123).
- `@anhlp/alp-gateway`: the `files.read` permission (never a default; confined to a granted
  workspace, read-only, 1 MiB, a block list for `.git`, `.alp`, `.ssh`, `.env*` and keys),
  read-only `library.get` with redaction, inline images within its own limits, typed tool-call
  details only in the caller's scope, and no host paths or file contents in forwarded errors
  (PR #123).

## Support

Unchanged from `0.0.0-beta.1` (below): Linux and macOS; Node.js 22 (22.12 or later) and 24;
Codex CLI and Claude Code; Paseo `>=0.11.1 <0.12.0`. Windows, Node.js 26, ACP and Antigravity
stay experimental.

## What is in the beta

Included, Experimental and Deferred are as in `0.0.0-beta.1` (below). The new alpd protocol
features above are covered by the hermetic suites; the clients that use most of them (`apps/web`,
the gateway) are still deferred.

## Known issues

- Real Codex and Claude runs on the release tarballs are a release condition on macOS only
  (beta-scope D7). On Linux, the hermetic CI suites and fake-provider rehearsals on the same
  tarballs pass; real-provider runs there are done when possible. Windows stays experimental.
- In Paseo and `alp web`, a session on Claude shows the assistant's text only once each message
  is complete; Codex sessions stream as they go. Stop still works
  ([#107](https://github.com/phucanh08/alp/issues/107)).
- Windows: no login service; tests that use a fake Codex or POSIX processes are skipped there;
  no CI lane runs the whole suite.
- Client SDK smoke tests (browser, Metro, tarball) are not in CI.
- A backup does not hold Codex or Claude threads, which those tools keep; a restore on another
  machine does not bring their native context.
- `alp web` is Paseo's web app at a pinned commit with ALP's patches. What Paseo has and ALP
  has not built yet (terminals, commit and push, worktrees from the app, voice, …) says it is
  in development.
- `alp --version` prints the usage instead of the version.
- Older versions (`@anhlp/alp` 0.3.0–0.10.0, the other `@anhlp/alp-*` 0.10.0) and the old
  plugin name `alp-paseo-plugin` are deprecated on npm; they still install, with a warning.
  `0.0.0-beta.1` is not deprecated.

## Checksums

The release attaches the eight `*-0.0.0-beta.2.tgz` tarballs, `SHA256SUMS` and
`release-manifest.json`. Check a download with `shasum -a 256 -c SHA256SUMS` (macOS) or
`sha256sum -c SHA256SUMS` (Linux).

Release commit `1b16b14004e01eb6d5064a3e9cddb642f9d9f509`. `SHA256SUMS` (its own SHA-256 is
`916f49a91a3069c61bdb3bd6f2fdb9e27436acd33167f44891fabbed08040364`):

```text
94326c505df4704db830ffe3c65883980c93929d9a1b6718173d150cc371395a  anhlp-alp-0.0.0-beta.2.tgz
bd6addcbc76df731cc89b6e4e100fc5070e3f5b1a37f91288709208bc44f4ab8  anhlp-alp-cli-0.0.0-beta.2.tgz
d597ec27b08769a07620699e18f706392df742e82f4a486f5437c89578de9971  anhlp-alp-client-0.0.0-beta.2.tgz
ccac64973f98465a3e630b63c5c7d8ed5c625e9afaa87a24c3d92ac86f909e6e  anhlp-alp-core-0.0.0-beta.2.tgz
2b0b093db49278cf4fea0fa4d06756874dd5b6f2541a8008f01caccb88cdaca3  anhlp-alp-daemon-0.0.0-beta.2.tgz
e46e0cabae3843e671bd9cfdedd4e6e48e2e86e0564d29b7d7181acc0bb3588b  anhlp-alp-paseo-0.0.0-beta.2.tgz
502272b511b73f192d20c2934e03a679fde331e06f055dd185753cd54aacb975  anhlp-alp-protocol-0.0.0-beta.2.tgz
312dd6654f4f61fa0296eef574b0e5980b508bfa5ea480c67312140687930132  anhlp-alp-runtime-0.0.0-beta.2.tgz
```

## More

- [Install, upgrade, back up and remove](beta-install.md)
- [Backups, restores, upgrades and recovery](data-recovery.md)
- [Paseo plugin](../../integrations/paseo/README.md) · [plugin internals](paseo-plugin.md)
- [Phở and Cafe teams](team-workflow.md) · [agent library](agent-library.md) ·
  [Codex only](codex-only.md)
- [Beta scope, gate and release checklist](beta-scope.md) (Vietnamese)

---

## 0.0.0-beta.1 (2026-10-16)

> Published on 2026-10-16 as the GitHub prerelease
> [v0.0.0-beta.1](https://github.com/phucanh08/alp/releases/tag/v0.0.0-beta.1); there the links are
> absolute, at the tag. Scope, gate and post-publish results: [beta-scope.md](beta-scope.md) §6.4.

ALP's first beta: the `alp` CLI and its per-user daemon `alpd`, which run filesystem-defined
agent teams on Codex CLI and Claude Code, and an optional plugin that shows them in Paseo and
serves `alp web` on this machine.

### Install

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

### Packages

All at `0.0.0-beta.1`, on the npm tag `beta`; internal dependencies are pinned to that version.

| Package | In this beta | Contents |
|---|---|---|
| `@anhlp/alp` | Published | `alp` and `alpd`; no Paseo code |
| `@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli` | Published | installed with `@anhlp/alp` and the plugin |
| `@anhlp/alp-paseo` | Published | Paseo plugin, `alp web` (Paseo's web app, Apache-2.0, with ALP's patches), `alp-web-integration` |
| `@anhlp/alp-gateway` | Not published (deferred) | — |
| `@anhlp/alp-web` (`apps/web`) | Not published (deferred) | — |
| `@anhlp/alp-tui` | Not published | — |

### Support

| | Supported | Experimental | Not supported |
|---|---|---|---|
| OS | Linux, macOS | Windows: CLI and a local alpd; no `alp daemon install`; CI runs only a daemon/IPC subset | — |
| Node.js | 22 (22.12 or later), 24 | 26 (local evidence only) | 20 (end of life 2026-04-30) |
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (full access; its read-only is only an instruction in the prompt) | — |
| Paseo host | `>=0.11.1 <0.12.0` | — | 0.12 and later |

### What is in the beta

**Included** (covered by the beta's acceptance gate):

- CLI and alpd: `init`, `update-template`, `update`, `setup`, `doctor`, `daemon start|stop|restart|status`, `run`,
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

### Known issues

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
  (see Install). Fixed in `0.0.0-beta.2`, which ships the plugin without declarations: from
  that version `paseo plugin add npm:@anhlp/alp-paseo@beta` is the install command
  ([#111](https://github.com/phucanh08/alp/issues/111)).
- Older versions (`@anhlp/alp` 0.3.0–0.10.0, the other `@anhlp/alp-*` 0.10.0) and the old
  plugin name `alp-paseo-plugin` are deprecated on npm; they still install, with a warning.

### Checksums

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

### More

- [Install, upgrade, back up and remove](beta-install.md)
- [Backups, restores, upgrades and recovery](data-recovery.md)
- [Paseo plugin](../../integrations/paseo/README.md) · [plugin internals](paseo-plugin.md)
- [Phở and Cafe teams](team-workflow.md) · [agent library](agent-library.md) ·
  [Codex only](codex-only.md)
- [Beta scope, gate and release checklist](beta-scope.md) (Vietnamese)
