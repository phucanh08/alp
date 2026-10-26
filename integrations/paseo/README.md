# ALP provider for Paseo

Filesystem-defined agents backed by local Codex or Claude Code. The model picker
offers two profiles, and nothing else:

- **Phở**: main implements or delegates directly to peer.
- **Cafe**: main supervises lead, which implements or delegates to peer.

In both, main runs on Opus 5.5 with high effort and full access, and starts a
supervisor on Sonnet 5, shown as a child session, that reviews main's process
after each turn and asks main about mistakes; main records lessons it follows in
later sessions. Both profiles support read-only reviewer and oracle agents; oracle
runs on Fable or Astra, and main may ask both for two opinions. New projects default
to Phở and a maximum of two concurrent peers. Writing assignments in the shared
checkout run one at a time; in a git repository, writing peers can run in parallel,
each in its own worktree, and their changes are merged back with `alp_merge`.

## Tasks panel

Each workspace gets a **Tasks** panel (also in the command center as "Open ALP
tasks") showing the tasks of its ALP project, in `.alp/tasks`:
- First, what waits for you: human gates you approve there. Then tasks in review
  with their handoff, in progress, ready, and blocked or waiting.
- Recently closed tasks are folded away.
- You can add a task with a priority, close a task, accept one in review, or
  reopen one.

The panel reads and writes the task files through the plugin's server, so it
works without alpd, and it refreshes every five seconds while open.

On a phone, where the workspace's panels are out of reach, the same board opens
as a full screen from the chat:
- the **Tasks** pill in the composer of each ALP agent (for example "Tasks · 3")
  lists the open tasks. Tapping one opens it; **All tasks** opens the board.
- `/alp-tasks` opens the board, and `/alp-tasks <id>` opens that task.

## Host settings on the ALP web app

Settings → Host exposes **Templates**, **Agents**, **Skills**, **Hooks**, and
**MCP servers** directly. Templates opens the Phở/Cafe team editor for models,
members, delegation, supervisor, and house rules. Changes are saved in the selected
host's ALP library; saving a built-in entry creates an override. The ALP plugin
settings screen and the ALP project panel remain available for library management
and project overrides.

## Managed worktree removal through the web facade

The facade accepts Paseo's native `paseo_worktree_archive_request`. Set
`scope: "worktree"` to remove an ALP-managed user worktree, targeting its
`workspaceId` or absolute `worktreePath` (or `repoRoot` and `branchName`). If
multiple target fields are supplied they must agree. A workspace archived earlier
can still be targeted explicitly. Removal retains the Git branch.

The daemon's `workspace.worktree.remove` is the sole deletion authority. It checks
the creator, approved mapping, checkout identity, dirty files, runtime admission,
leases, assignments and saved session history. A refusal leaves workspace metadata
and checkout files intact; sessions are never archived to bypass these checks.
External checkouts cannot be deleted. Older daemons return an upgrade error.

Omitting `scope`, choosing `scope: "workspace"`, or using
`archive_workspace_request` only archives the workspace. As in supported Paseo
0.11.1–0.12.x, the legacy `deleteWorktreeFromDisk` flag does not request deletion.
This follows [Paseo's native archive contract](https://github.com/getpaseo/paseo/blob/b63a325be3d3ae444fbd38815658cca01ab1288f/packages/server/src/server/worktree/commands.ts#L121).

## Install

This is the beta `0.0.1-beta.3` (until it is on npm, `@beta` installs `0.0.0-beta.2`, which Paseo 0.12 refuses; check with
`npm view @anhlp/alp-paseo dist-tags`); name it when you install (`@beta`, or
exactly `@0.0.1-beta.3`). See the
[release notes](https://github.com/phucanh08/alp/blob/main/docs/alp/beta-release-notes.md) and
[install, upgrade and removal steps](https://github.com/phucanh08/alp/blob/main/docs/alp/beta-install.md).

Requires Paseo `>=0.11.1 <1.0.0` (the published `0.0.1-beta.3` declares `<0.13.0`, so 0.11.x or 0.12.x), Node.js 22 (22.12 or later) or 24 on Linux or macOS
(Windows and Node.js 26 are experimental), and an authenticated native Codex or Claude Code
executable on PATH.

ALP sessions run in `alpd`, a per-user daemon from the `@anhlp/alp` package; Paseo
only views them. Install the CLI and start the daemon once, so it records where
it is installed:

```sh
npm install -g @anhlp/alp@beta
alp daemon start
```

Coming from 0.10.0 or earlier, where this plugin was `alp-paseo-plugin`: remove it with
`paseo plugin remove alp-provider` before adding this one; `paseo plugin update` would fetch
the old name.

Then enable plugins in Paseo Settings → Plugins and add the provider:

```sh
paseo plugin add npm:@anhlp/alp-paseo@beta
paseo provider models alp
```

This works from `0.0.0-beta.2`, which ships no type declarations. In `0.0.0-beta.1` the `npm:`
source fails: Paseo installs it without peers and cannot resolve the `@getpaseo/*` types the
plugin's declarations import ([#111](https://github.com/phucanh08/alp/issues/111)). With beta.1,
install it with npm and add it by path:

```sh
npm install -g @anhlp/alp-paseo@beta
paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"
```

From then on the plugin keeps alpd running while Paseo runs. It starts alpd when
Paseo starts, checks every 5 seconds, and starts it again when alpd is down; with
`alp daemon install` (experimental), it starts alpd through that service. Sessions open in Paseo
stay open across the restart: the plugin reconnects, shows that it lost and
regained alpd, and a session alpd did not reopen resumes from its thread at the
next prompt. After `alp daemon stop` the plugin leaves alpd stopped until you
prompt in Paseo, run `alp daemon start`, or start Paseo again. Set
`ALP_SUPERVISE=0` in the Paseo daemon's environment to turn the watching off. If the provider
reports that alpd.js was not found, run `alp daemon start` once, or set
`ALP_DAEMON_ENTRY` to the absolute path of `alpd.js` in the Paseo daemon's
environment. `ALP_HOME` (default `~/.alp`) selects the daemon's directory and
must match between the CLI and Paseo.

The provider offers images when alpd's connection handshake (or `daemon.hello`
for an embedded connection) lists `prompt.images`, and Paseo requests them.
Individual sessions still validate runtime support and image limits. The offer
is fixed for the provider connection; a replacement backend validates each prompt.
Missing or failed capability discovery leaves images unavailable.

Forge issues and change requests, legacy GitHub attachments, reviews, and text
context are sent as ordinary user text using Paseo's attachment rendering. Bodies
and review lines retain their content and order; context metadata grants no system
authority. Uploaded files continue through alpd's attachment store. Native command prompts
(`{ type: "command", name, arguments }`) are unsupported: the provider does not
advertise `prompt.command` and rejects them before waking or contacting a session.
It does not translate commands into prose.

Closing an agent in Paseo stops watching it; work in progress finishes in
alpd. Use interrupt to stop work. You talk with main: when main asks you a
question with `alp_ask`, Paseo shows it as a question prompt; your answer, or a
dismissal, goes back to main. Other agents reach you only through main, unless
you write to one of them with `alp send`. `alp top` shows the whole tree live. Sessions started with `alp run` can be
imported into Paseo with their child agents.

Select ALP and a profile, Phở or Cafe, when creating a new session. There is no
Workflow setting, and model and effort are not chosen in Paseo; the permission mode
defaults to full access. Missing ALP starter files are initialized automatically.
The profile stays fixed for the session. To change main's model, set `runtime.model`
in `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "cafe", "maxPeers": 2 },
  "runtime": { "model": "claude:claude-fable-5-1", "reasoning": "high" }
}
```

Skills and the skills each role gets live in your library in `ALP_HOME`
(`skills/` and `role-skills.json`), seeded on first use; app updates do not
overwrite what you changed.
`ALP_CODEX_BIN` and `ALP_CLAUDE_BIN` can select absolute native executables.

See [workflow and migration documentation](https://github.com/phucanh08/alp/blob/main/docs/alp/team-workflow.md)
for existing projects, model selection, permissions, and runtime limitations.

## Remote mode (deferred, not in the beta)

Remote mode is **not part of the beta (`0.0.1-beta.3`)**: it needs `@anhlp/alp-gateway`, which is not
published. The text below describes the code in this repository for development only.

To use ALP running on another machine, start the daemon process that loads this plugin with
`ALP_GATEWAY_URL` (the ALP host's gateway, `https://…`; `http://` only for a loopback host) and
`ALP_GATEWAY_TOKEN` (printed once by `alp-gateway credential create` on the ALP host). The
plugin then reaches alpd only through the gateway: it starts nothing on this machine and reads
no ALP files here. Open a workspace whose folder is exactly a path the credential grants.
Sessions, questions, tasks, teams and the library list work; library content and edits,
tests, usage, git and files are shown as unavailable. See
[Paseo remote mode](https://github.com/phucanh08/alp/blob/main/docs/alp/paseo-remote.md).

## Workspace development

From the repository root:

```sh
npm run build -w @anhlp/alp-paseo
npm run test -w @anhlp/alp-paseo
npm pack -w @anhlp/alp-paseo
```

`integrations/paseo` owns the plugin client, server, shared types and manifest. The build writes the self-contained server bundles (including the integration entry `server/dist/main.js` and `server/dist/alpd.js`) and the web app to `server/dist`; only the plugin package ships these Paseo artifacts. The npm package is `@anhlp/alp-paseo` (`alp-paseo-plugin` up to 0.10.0); the Paseo plugin ID remains `alp-provider`.

## Optional web installation

`@anhlp/alp` and the six core packages install without Paseo. To use the web UI:

```sh
npm install -g @anhlp/alp@beta @anhlp/alp-paseo@beta
alp-paseo-integration --register
alp web --print
alp web pair --off
```

Normal npm installs resolve the plugin's required peers (`@getpaseo/*`, `ws`); React and
React Native are optional peers that the Paseo app provides, so npm does not install them.
Do not use `--legacy-peer-deps` for a standalone installation unless you supply the required
peers explicitly. The binary is also discoverable on PATH, so registration is optional
for a global install. For a local install, run
`./node_modules/.bin/alp-paseo-integration --register` with the intended `ALP_HOME`.

A plugin directory managed by `paseo plugin add npm:…` is not a standalone web
installation. Paseo installs it without peers and supplies `@getpaseo/plugin` through
its plugin loader. Running `node <managed-plugin>/server/dist/main.js --register`
directly bypasses that loader and can fail with `ERR_MODULE_NOT_FOUND` for
`@getpaseo/plugin`; this invocation from the managed directory is unsupported
([#154](https://github.com/phucanh08/alp/issues/154)). Use the normal npm installation
and `alp-paseo-integration --register` shown above. For a local npm installation with
required peers, use `./node_modules/.bin/alp-paseo-integration --register` with the
intended `ALP_HOME`. Registration records the entry path; it does not install missing
peers or turn a host-managed plugin into a standalone installation.

Adding the plugin to a Paseo host (`npm:` from beta.2; by path in beta.1, see above) remains
available independently of this standalone web process.

Core upgrades no longer update a bundled plugin: upgrade `@anhlp/alp-paseo`
separately, and re-register if its installation location changes. Keep existing
`web` settings and ALP session storage. The integration is named `paseo`: it keeps its token and
server identity in `paseo.json` (carried over once from a `web.json` written before the rename),
locks `integrations/paseo.lock`, registers `integrations/paseo.json` and binds a port the system
picks, since `web.port` and `web.json` now belong to `alp-web`. `alp-web-integration` remains an
alias of `alp-paseo-integration` for one release, and a home that has only the old
`integrations/web.json` descriptor still starts it, with a hint to re-register.
When Paseo's app asks for a password, give it the one `alp web pair` prints.
`alp web`, `alp web --print`, `alp web pair --on/--off`, `ALP_WEB_INTEGRATION`,
`ALP_INTEGRATION_ENTRY`, `ALP_DAEMON_ENTRY`, `ALP_SUPERVISE` and `ALP_HOME` retain
their meanings. Without the plugin, web commands explain how to install it;
CLI, daemon, IPC and ACP remain usable.

The public provider (`alp`), plugin ID (`alp-provider`), exports (`.`, `/main`,
`/web`, `/paseo/*`, `/panel/*`), Phở/Cafe sessions, streaming/cancel, delegation,
human questions, Tasks/settings panels, web authentication, relay pairing and
daemon supervision/reconnection are unchanged. `release:tarball-check` runs the
existing provider, team, human, web, relay and transport regressions against a
separately installed plugin and real SDK peers.

For source builds, `npm run build:paseo` builds the server; `npm run build:web`
builds the pinned web app. Plugin prepack verifies its own web artifact. Neither
step is required by core build/prepack.
