# Installing, upgrading and removing the ALP beta (`0.0.1-beta.3`)

This guide covers the beta (`0.0.1-beta.3`; earlier betas were `0.0.0-beta.1` and `0.0.0-beta.2`): a new install, signing in to a provider, the daemon, the
Paseo plugin, `alp web` on this machine, upgrading from 0.10.0 or earlier, backups, going back,
and removing ALP. What the beta includes and what it does not is in the
[release notes](beta-release-notes.md); the scope, gate and release checklist are in
[beta-scope.md](beta-scope.md).

> **Check the version.** Until `0.0.1-beta.3` is on npm, the `@beta` commands below install
> `0.0.0-beta.2`, whose plugin does not load in Paseo 0.12. Check with `npm view @anhlp/alp
> dist-tags`: it lists `beta: '0.0.1-beta.3'` once beta.3 is published.

## Always ask for the beta

npm's `latest` tag moves to a new beta only after that beta's post-publish checks, so a command
without a tag or version can install an older version. Every command here names the beta,
either by tag or exactly:

| Package | By tag | Exact |
|---|---|---|
| CLI and daemon | `@anhlp/alp@beta` | `@anhlp/alp@0.0.1-beta.3` |
| Paseo plugin (and `alp web` up to `0.0.1-beta.3`) | `@anhlp/alp-paseo@beta` | `@anhlp/alp-paseo@0.0.1-beta.3` |

The six core packages (`@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`,
`-cli`) come with these at the same pinned version; you do not install them yourself. The old
plugin name `alp-paseo-plugin` stays at `0.10.0`; do not install it with the beta.

Use `npm install`, not `npm update`, to move to the beta: by semver, `0.0.1-beta.3` sorts below
`0.10.0`.

## Requirements

| | Supported | Experimental | Not supported |
|---|---|---|---|
| OS | macOS, Linux (see below) | Windows: CLI and a local alpd; no `alp daemon install` | — |
| Node.js | 22 (22.12 or later), 24 | 26 (local evidence only) | 20 (end of life) |
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (full access; its read-only is only an instruction in the prompt) | — |
| Paseo (for the plugin) | `>=0.11.1 <1.0.0` from the release after `0.0.1-beta.3`; `0.0.1-beta.3`: `<0.13.0` (0.11.x and 0.12.x); `0.0.0-beta.2` and earlier: `<0.12.0` | — | 1.0 and later; 0.13 and later with `0.0.1-beta.3` |

macOS is the primary test platform: this beta is accepted there with real Codex and Claude.
Linux passes the same automated tests (the providers are simulated there); real-provider runs on
Linux, and any testing on Windows, happen when possible.

You need at least one of Codex CLI or Claude Code installed and signed in. ALP does not
install or sign in to them.

## New install

### 1. CLI and daemon

```sh
node -v                                   # v22.12+ or v24
npm install -g @anhlp/alp@beta
npm ls -g @anhlp/alp                      # @anhlp/alp@0.0.1-beta.3
```

The package provides `alp`; `alp` starts `alpd`, the per-user daemon that runs sessions.

### 2. Sign in to a provider, then check

```sh
codex login                # Codex CLI
claude auth login          # Claude Code
alp doctor                 # what ALP needs here; --fix repairs only what is safe to
```

`alp doctor` shows each provider it finds and whether it is signed in, and names the sign-in
command when it is not. A provider that is not installed is a warning while another one is
ready, and a failure when none is. When a CLI is not on `PATH`, set `ALP_CODEX_BIN` or
`ALP_CLAUDE_BIN` to its absolute path.

### 3. Start the daemon

```sh
alp daemon start
alp daemon status          # alpd <version> running …; ready
```

`alp daemon status --json` prints the same as JSON; it exits 0 when ready, 3 when alpd is not
running and 4 when it runs but is not ready. `alpd` keeps its data in `$ALP_HOME` (default
`~/.alp`); the CLI and Paseo must use the same `ALP_HOME`.

`alp daemon install` (launchd on macOS, systemd on Linux) runs alpd as a login service. It is
**experimental** in this beta, and not available on Windows. `alp daemon uninstall` removes it.

### 4. Set up a project

```sh
cd your-project
alp init                                  # ALP.md and .alp/settings.json
alp setup --runtime codex                 # or claude, or mix; plain `alp setup` asks
alp run --team pho "Read this folder and list its files. Change nothing."
```

`alp setup` writes Phở and Cafe's models into `.alp/settings.json`. It does not install CLIs,
sign in or call models. Its other options (`--prefer`, `--claude-model`, `--codex-model`,
`--claude-supervisor`, `--codex-supervisor`, `--claude-oracle`, `--codex-oracle`) are in the
usage `alp` prints when run with no command, and in the [README](../../README.md#install).
Codex only: see [codex-only.md](codex-only.md).

## Remote terminals (optional, off by default)

alpd can run a real terminal (a shell) for remote clients: the ALP web app through `alp-gateway`,
and Paseo app devices paired with this host. The shell runs **as the account that runs alpd**, with
its files, programs and network; a workspace only picks the directory it starts in and is **not a
sandbox**. It stays off until you opt in on the host:

```sh
alp terminal allow --yes          # gateway credentials that hold terminal.exec may open terminals
alp terminal allow --paseo --yes  # also Paseo app devices paired with this host
alp terminal status
alp terminal deny                 # off; alpd ends every open terminal within 5 seconds
```

A gateway credential also needs the separate permission `terminal.exec`, which is never a default
(docs/alp/remote-gateway.md §5.18).

The PTY comes from [`node-pty`](https://github.com/microsoft/node-pty) `1.2.0-beta.15` (MIT,
Microsoft), pinned exactly. It is an **optional dependency** of `@anhlp/alp`, `@anhlp/alp-cli`,
`@anhlp/alp-daemon` and `@anhlp/alp-paseo`, and alpd loads it only when a terminal is first needed:

- Its tarball carries prebuilt N-API binaries for macOS and Linux (x64, arm64) and Windows, so no
  compiler is needed. Its install script only checks for a prebuild; with `--ignore-scripts`, or npm's
  pending `allow-scripts` approval, it still works.
- It adds about 27 MB unpacked, mostly Windows debug symbols.
- If it fails to install or load, everything else works and alpd simply never offers terminals.
- Windows: terminals are not supported and the capability is never listed.

## Paseo plugin

The plugin `@anhlp/alp-paseo` shows ALP's sessions in Paseo `>=0.11.1 <1.0.0` (releases after `0.0.1-beta.3`;
`0.0.1-beta.3` declares `<0.13.0`, so Paseo 0.13 refuses it). Plugin
releases up to `0.0.0-beta.2` declare `<0.12.0`, and Paseo 0.12 refuses to load them (`Plugin
"alp-provider" requires Paseo >=0.11.1 <0.12.0`); use `0.0.1-beta.3` or later with
Paseo 0.12. Sessions run
in alpd, so install the CLI and start alpd first (above). Then, in Paseo, open
**Settings → Plugins**, turn on **Enable plugins**, and run:

```sh
paseo plugin add npm:@anhlp/alp-paseo@beta
paseo plugin ls                           # alp-provider is running
paseo provider models alp                 # Phở and Cafe
```

This works from `0.0.0-beta.2`. In `0.0.0-beta.1` the `npm:` source fails with `Could not
resolve type dependency "@getpaseo/relay/e2ee"` ([#111](https://github.com/phucanh08/alp/issues/111));
with beta.1, install the plugin with npm and add it by its installed path instead:

```sh
npm install -g @anhlp/alp-paseo@beta
paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"
```

Paseo plugins are trusted, unsandboxed code. The plugin keeps alpd running while Paseo runs.
More: [integrations/paseo/README.md](../../integrations/paseo/README.md) and
[paseo-plugin.md](paseo-plugin.md).

## `alp web` on this machine

> From the release after `0.0.1-beta.3`. In `0.0.1-beta.3` itself, `alp web` is Paseo's web app
> in `@anhlp/alp-paseo` and needs `alp-paseo-integration --register` first.

`alp web` opens ALP's web app (`apps/web`), which ships in the CLI (`@anhlp/alp`); it needs neither
Paseo nor `@anhlp/alp-paseo`.

```sh
alp web              # starts the alp-web service if needed and opens its address with its token
alp web --print      # prints the address instead
alp web rotate       # replaces the token; pages already open lose access
```

- The `alp-web` service listens on `127.0.0.1` only, at `web.port` (default 7433; if it is busy,
  the next nine ports). One port carries the app and its embedded gateway. On a headless Linux
  machine, forward it and open the printed address on your own machine:
  `ssh -L 7433:127.0.0.1:7433 <host>`.
- The address is `http://127.0.0.1:<port>/#token=alpgw1.…`. The token is a gateway credential
  kept in `~/.alp/web/credentials.json`, a store of alp-web's own: `alp-gateway credential list`
  does not show it. The page keeps the token only in that tab's session storage. When the page
  says the token is no longer valid, run `alp web` again.
- `alp web rotate` stops alp-web, replaces the credential (the old token stops working) and starts
  it again; get the new address from its output or `alp web --print`.
- The token may read and drive sessions and projects and add projects. To allow more, list the
  permissions in `~/.alp/settings.json`, for example
  `"web": { "permissions": ["files.read", "attachments.write"] }` (others: `session.team.write`,
  `terminal.exec`). If one entry is not a permission, the whole list is ignored with a warning;
  an entry that is not a lowercase name with dots (such as `"files-read"`) makes the whole
  `settings.json` invalid, so alp-web ignores all of it, `web.port` included, and logs
  `ALP_SETTINGS_INVALID` in `~/.alp/logs/integrations/alp-web.log`.
- It reaches the projects alpd knows, and the folder you ran `alp web` in when it started the
  service, if that folder is an ALP project.
- alp-web keeps alpd running (`ALP_SUPERVISE=0` turns that off). It reads `web.port`,
  `web.permissions` and `web.enabled` when it starts, and `alp daemon stop` does not stop it: to
  apply a change, stop the process whose pid `~/.alp/web.json` names (`kill <pid>`; on Windows `taskkill /PID <pid>`), then run
  `alp web`.
- **Windows: untested.** CI runs alp-web's tests on Linux and macOS only, and macOS remains the
  primary platform. A trial on Windows CI found writes of the credential file failing now and then
  with `EPERM`, which can make `alp web rotate`, a workspace grant update or a start that replaces the token fail. On Windows alp never
  stops a running alp-web or the old Paseo integration for you: `alp web rotate` and the upgrade
  takeover refuse while one runs. End the process whose pid `~/.alp/web.json` names
  (`taskkill /PID <pid>`), then run the command again. Ending it this way is not a clean shutdown;
  the next start reclaims its lock.

More: [web.md](web.md#31-alp-web-trên-máy-này-alp-web).

### Upgrading from the Paseo-based `alp web`

Before the rename, the Paseo integration ran as integration `web` and kept its token and server id
in `~/.alp/web.json`. The first `alp web` after the upgrade:

- stops that integration if it still holds `integrations/web.lock`, with SIGTERM, and only when it
  can prove the process is yours, from this boot, and the one that took the lock (on Windows it
  never stops it: stop it yourself). Any other holder is reported and left running;
- copies the old token and server id from `web.json` to `~/.alp/paseo.json`, once and only when
  `paseo.json` does not exist yet, so devices paired through the relay keep working; then alp-web
  writes its own `web.json`.

From the CLI, only `alp web pair` starts the Paseo integration now, as integration `paseo`.

### Paseo's app on another device (optional)

The Paseo integration in `@anhlp/alp-paseo` runs apart from alp-web, as integration `paseo` on a
port the system picks, and keeps its token in `~/.alp/paseo.json`. You need it only to pair
Paseo's app on another device through the relay, which is **experimental** and off by default:

```sh
npm install -g @anhlp/alp-paseo@beta
alp-paseo-integration --register            # in the ALP_HOME you use
alp web pair --on                         # turns the relay on and prints the pairing link
```

Normal npm installs bring the plugin's required peers (`@getpaseo/*`, `ws`); React and React
Native are optional peers that the Paseo app provides, so npm does not install them. Do not add
`--legacy-peer-deps`. When Paseo's app asks for a password, give it the one `alp web pair` prints
(the token in `~/.alp/paseo.json`). `alp-web-integration` remains an alias of
`alp-paseo-integration`, and `ALP_WEB_INTEGRATION` of `ALP_PASEO_INTEGRATION`, for one release.

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


## Upgrading from 0.10.0 or earlier

0.10.0 has no `alp backup` or `alp restore`, so copy alpd's home yourself before upgrading.
0.10.0 also shipped `alp web` inside `@anhlp/alp`; betas up to `0.0.1-beta.3` move it to
`@anhlp/alp-paseo`, and later ones bring ALP's own `alp web` back into `@anhlp/alp`. The Paseo
plugin changed its npm name from `alp-paseo-plugin` to `@anhlp/alp-paseo` (its
plugin ID, `alp-provider`, is the same).

1. Let running work finish, and do not prompt ALP sessions in Paseo during the upgrade: the
   plugin starts alpd again when you prompt.
2. Stop alpd and copy its home (macOS/Linux; use your `ALP_HOME` if you set one):

   ```sh
   alp daemon stop
   cp -Rp ~/.alp ~/alp-home-before-beta
   ```

3. Install the beta, and the plugin if you use Paseo (or, up to `0.0.1-beta.3`, `alp web`):

   ```sh
   npm install -g @anhlp/alp@beta @anhlp/alp-paseo@beta
   npm ls -g @anhlp/alp @anhlp/alp-paseo     # both 0.0.1-beta.3
   alp-paseo-integration --register
   ```

4. Replace the Paseo plugin. `paseo plugin update` would fetch the old name again, so remove it
   and add the new one:

   ```sh
   paseo plugin remove alp-provider
   paseo plugin add npm:@anhlp/alp-paseo@beta
   # beta.1 only (#111): npm install -g @anhlp/alp-paseo@beta
   #                     paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"
   ```

5. Start alpd and check it:

   ```sh
   alp daemon start
   alp daemon status
   alp doctor
   ```

   On its first start the beta moves alpd's state from schema 1 to schema 2. It saves
   `$ALP_HOME/backups/pre-migrate-v1-v2-<time>.alpbackup` first, and puts the state back from it
   if the step fails ([upgrades](data-recovery.md#upgrades-state-migrations)).
6. Take a first backup with the beta, and copy it off the machine:

   ```sh
   alp backup --stop
   alp backup list
   ```

7. If you used `alp daemon install`, run it again so the service names this installation.
8. Projects made with an older scaffold: `alp upgrade [directory]`. That updates the project's
   ALP files, not the npm package.

Codex and Claude keep their own threads; the upgrade does not touch them.

## Backups and recovery

```sh
alp backup --stop                     # stops alpd, writes $ALP_HOME/backups/backup-<time>.alpbackup, starts alpd
alp backup -o FILE --stop             # to another path; --project DIR adds a project, --no-projects leaves them out
alp backup verify FILE                # checks every checksum; changes nothing
alp backup list
alp restore FILE --dry-run            # says what it would replace; changes nothing
alp restore FILE --stop               # keeps what it replaces in pre-restore-<time>.alpbackup
```

A backup holds sessions, timelines, settings, your library and the projects' tasks. It does
not hold Codex or Claude threads, so sessions restored on another machine show their history
but do not resume natively. Backups can hold credentials and are not encrypted; keep them
private. Everything else, including what to do when alpd will not start:
[data-recovery.md](data-recovery.md).

## Going back to 0.10.0

The beta never converts its state back. 0.10.0 reads schema 2 (it only adds cursors that
0.10.0 already reads), so:

```sh
alp backup --stop                          # keep what the beta wrote
alp daemon stop
npm install -g @anhlp/alp@0.10.0
paseo plugin remove alp-provider           # if you use Paseo
paseo plugin add npm:alp-paseo-plugin@0.10.0
alp daemon start
```

To return to the data from before the upgrade instead, stop alpd and put back the copy from
step 2 of the upgrade yourself. Work done on the beta is not in that copy.

## Removing ALP

These steps remove the programs and the Paseo plugin. They delete no data.

```sh
alp backup --stop                          # optional; copy the file out of ~/.alp
alp daemon uninstall                       # only if you used alp daemon install; stops alpd too
alp daemon stop
paseo plugin remove alp-provider           # if you added the plugin
npm uninstall -g @anhlp/alp-paseo @anhlp/alp
```

What stays, for you to keep or remove yourself once you no longer need it:

- `$ALP_HOME` (default `~/.alp`): sessions, settings, your library, logs, backups,
  `paseo.json` (the Paseo integration's token) and `integrations/paseo.json`, `web.json` and
  `web/credentials.json` (alp-web's address and token), and `integrations/web.json` from earlier
  versions;
- in each project: `ALP.md` and `.alp/` (including `.alp/tasks`), and git branches
  `alp/<id>` that hold an assignment's work;
- with Antigravity: the `alp` entry ALP added to `~/.gemini/config/mcp_config.json`;
- Codex's and Claude's own threads (`~/.codex`, `~/.claude`).

Remove any of them only after you have a backup you have checked with `alp backup verify`.
