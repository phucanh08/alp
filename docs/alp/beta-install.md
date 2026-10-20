# Installing, upgrading and removing the ALP beta (`0.0.0-beta.2`)

This guide covers the beta (`0.0.0-beta.2`; the first beta was `0.0.0-beta.1`): a new install, signing in to a provider, the daemon, the
Paseo plugin, `alp web` on this machine, upgrading from 0.10.0 or earlier, backups, going back,
and removing ALP. What the beta includes and what it does not is in the
[release notes](beta-release-notes.md); the scope, gate and release checklist are in
[beta-scope.md](beta-scope.md).

> **Check the version.** Until `0.0.0-beta.2` is on npm, the `@beta` commands below install
> `0.0.0-beta.1`. Check with `npm view @anhlp/alp dist-tags`: it lists `beta: '0.0.0-beta.2'`
> once beta.2 is published.

## Always ask for the beta

npm's `latest` tag moves to a new beta only after that beta's post-publish checks, so a command
without a tag or version can install an older version. Every command here names the beta,
either by tag or exactly:

| Package | By tag | Exact |
|---|---|---|
| CLI and daemon | `@anhlp/alp@beta` | `@anhlp/alp@0.0.0-beta.2` |
| Paseo plugin and `alp web` | `@anhlp/alp-paseo@beta` | `@anhlp/alp-paseo@0.0.0-beta.2` |

The six core packages (`@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`,
`-cli`) come with these at the same pinned version; you do not install them yourself. The old
plugin name `alp-paseo-plugin` stays at `0.10.0`; do not install it with the beta.

Use `npm install`, not `npm update`, to move to the beta: by semver, `0.0.0-beta.2` sorts below
`0.10.0`.

## Requirements

| | Supported | Experimental | Not supported |
|---|---|---|---|
| OS | macOS, Linux (see below) | Windows: CLI and a local alpd; no `alp daemon install` | — |
| Node.js | 22 (22.12 or later), 24 | 26 (local evidence only) | 20 (end of life) |
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (full access; its read-only is only an instruction in the prompt) | — |
| Paseo (for the plugin) | `>=0.11.1 <0.13.0` (0.11.x and 0.12.x; `0.0.0-beta.2` and earlier: `<0.12.0`) | — | 0.13 and later |

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
npm ls -g @anhlp/alp                      # @anhlp/alp@0.0.0-beta.2
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

## Paseo plugin

The plugin `@anhlp/alp-paseo` shows ALP's sessions in Paseo `>=0.11.1 <0.13.0`. Plugin
releases up to `0.0.0-beta.2` declare `<0.12.0`, and Paseo 0.12 refuses to load them (`Plugin
"alp-provider" requires Paseo >=0.11.1 <0.12.0`); use the release after `0.0.0-beta.2` with
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

`alp web` is Paseo's web app at a pinned commit with ALP's patches, shipped in
`@anhlp/alp-paseo` (not in `@anhlp/alp`). It listens on `127.0.0.1` only and needs the token
in its address. It is not the standalone app in `apps/web`, which is deferred.

```sh
npm install -g @anhlp/alp-paseo@beta
alp-web-integration --register            # in the ALP_HOME you use
alp web                                   # opens http://127.0.0.1:7433/… with its token
alp web --print                           # prints the address instead
```

Normal npm installs bring the plugin's required peers (`@getpaseo/*`, `ws`); React and React
Native are optional peers that the Paseo app provides, so npm does not install them. Do not add
`--legacy-peer-deps`. On a headless Linux machine, forward the port and open the address on
your own machine: `ssh -L 7433:127.0.0.1:7433 <host>`. Pairing Paseo's app on another device
through the relay (`alp web pair --on`) is **experimental** and off by default.

A plugin directory managed by `paseo plugin add npm:…` is not a standalone web
installation. Paseo installs it without peers and supplies `@getpaseo/plugin` through
its plugin loader. Running `node <managed-plugin>/server/dist/main.js --register`
directly bypasses that loader and can fail with `ERR_MODULE_NOT_FOUND` for
`@getpaseo/plugin`; this invocation from the managed directory is unsupported
([#154](https://github.com/phucanh08/alp/issues/154)). Use the normal npm installation
and `alp-web-integration --register` shown above. For a local npm installation with
required peers, use `./node_modules/.bin/alp-web-integration --register` with the
intended `ALP_HOME`. Registration records the entry path; it does not install missing
peers or turn a host-managed plugin into a standalone installation.


## Upgrading from 0.10.0 or earlier

0.10.0 has no `alp backup` or `alp restore`, so copy alpd's home yourself before upgrading.
0.10.0 also shipped `alp web` inside `@anhlp/alp`; the beta moves it to `@anhlp/alp-paseo`,
and the Paseo plugin changed its npm name from `alp-paseo-plugin` to `@anhlp/alp-paseo` (its
plugin ID, `alp-provider`, is the same).

1. Let running work finish, and do not prompt ALP sessions in Paseo during the upgrade: the
   plugin starts alpd again when you prompt.
2. Stop alpd and copy its home (macOS/Linux; use your `ALP_HOME` if you set one):

   ```sh
   alp daemon stop
   cp -Rp ~/.alp ~/alp-home-before-beta
   ```

3. Install the beta, and the plugin if you used `alp web` or Paseo:

   ```sh
   npm install -g @anhlp/alp@beta @anhlp/alp-paseo@beta
   npm ls -g @anhlp/alp @anhlp/alp-paseo     # both 0.0.0-beta.2
   alp-web-integration --register
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
  `web.json` (the web token) and `integrations/web.json`;
- in each project: `ALP.md` and `.alp/` (including `.alp/tasks`), and git branches
  `alp/<id>` that hold an assignment's work;
- with Antigravity: the `alp` entry ALP added to `~/.gemini/config/mcp_config.json`;
- Codex's and Claude's own threads (`~/.codex`, `~/.claude`).

Remove any of them only after you have a backup you have checked with `alp backup verify`.
