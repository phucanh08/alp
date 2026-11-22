# ALP 0.0.1-beta.11 — release notes

Prepared 2026-11-22 from the commits `v0.0.1-beta.10..3b0f96ae` (task t-81b0.11 bumped the
version). npm (8 packages, `beta` tag) and the GitHub release (archives, installers and the two
macOS DMGs) carry the same version from one main SHA, as in beta.10. Release acceptance runs the
repository's fake Codex and fake Claude on the packed tarballs; macOS decides it, Linux and Windows
are reported. **The gate's real-provider rows (§6.1 of [beta-scope.md](beta-scope.md)) were not run
for beta.11;** none of them is claimed as passed here. The known R1 (Codex) failure is unchanged
(below).

This release is mostly the dashboard and ALP.app catching up with Paseo (plan: board decision
p-3974fce3, compared with Paseo 0.16.2; the full table with every deviation is
[apps/web/docs/paseo-parity.md](../../apps/web/docs/paseo-parity.md), the deliberate differences
are in [docs/breaking-changes.md](../breaking-changes.md)).

**Upgrading from beta.10:**

1. `alp update` (bundle) or `npm install -g @anhlp/alp@beta` (npm), then `alp daemon restart` and
   restart `alp dashboard` (`alp dashboard --stop`, then `alp dashboard`): the new pages call
   methods that the beta.10 alpd and dashboard do not have.
2. ALP.app: download `ALP-0.0.1-beta.11-<arch>.dmg` and replace `/Applications/ALP.app`. It is still
   ad-hoc signed and not notarized, so the first open needs the same Gatekeeper step as beta.10
   ([desktop.md](desktop.md) §8).

Changes that affect an existing user:

- **The host owner can use every Settings page in ALP.app** (t-a95b.1, PRs #350–#353, #357). The
  dashboard's own credential on a direct loopback connection, not an ALP agent session, is the
  *host owner*: it gets owner-only methods that the alp dashboard process answers itself (Usage,
  Providers, Terminals, Workspaces, Projects, the skill/lesson library, file editing, the agents'
  language, model refresh). Any other credential gets the same refusal as before. **Settings no
  longer shows Voice, Pair device, Plugins or Metadata.** Remote gateway details:
  [remote-gateway.md](remote-gateway.md) §5.19, [dashboard.md](dashboard.md) §4.6.
- **The sidebar is laid out like Paseo's** (t-ff83, #354–#356): sessions under every workspace with
  sort, limit and search; for the owner, the branch, `+a -d`, PR and CI of each workspace, repo
  icons, a usage footer, a Schedules slot and **New workspace**. The default Show items change to
  Paseo's (branch on, host off); preferences you saved are kept.
- **Settings › Usage is Paseo's Usage page** (t-9116 A, #358): per-provider cards, window labels,
  plan badge, pins and the sidebar summary. `daemon.usage` gains optional fields; the account email
  is returned only to the owner's dashboard. A host-wide **Check usage** switch (default on) stops
  the dashboard from querying providers; `alp usage` and alpd's limit watch are not affected.
  Claude's extra usage is shown as Enabled/Disabled and no longer marks the provider `limited`.
- **Browser tab in ALP.app** (t-9116 B, #359; batch 4 #365): `+ › Browser` opens a web page in its
  own sandboxed partition (no preload, no Node, http/https only, the dashboard origin blocked,
  every permission denied, downloads cancelled). From batch 4 a tab keeps its page across tab
  switches and pane moves, and a navigation ALP.app stops shows "Blocked navigation to …". Not in a
  normal browser; no agent browser automation ([desktop.md](desktop.md) §4.1).
- **Session row ⋮ menu as Paseo's** (t-747e, #360): Copy path, Copy branch name, Rename, Mark as
  read / unread (new alpd method `session.attention.mark`), Open in file manager (owner, ALP.app),
  Archive.
- **Paseo parity batch 1 — desktop feel** (t-0166, #361): notifications for the dashboard origin
  only (Settings › Notifications, Test notification), ⌘W closes the current tab, Paseo's desktop
  shortcut set in ALP.app (⌘1–9, ⌘[ ⌘], ⌥⌘1–9), window bounds kept, a Dock dot for attention.
- **Batch 2 — menus** (t-a876, #362, #363): project ⋮ (Open in file manager, Open in editor for the
  owner, Remove project), session header ⋯ (copy items, New terminal, New browser tab, Rename, Copy
  session ID, Archive), Archive with Undo, session pin and labels (new `session.update` and
  `label.list`), Play sound and Refresh in Settings › Notifications.
- **Batch 3 — chat** (t-de48, #364): ⌘F / Ctrl+F find in the chat pane, `@` file mentions in the
  composer, Model / Thinking / Mode rows and Switch tab in the command center, a tab switcher per
  pane, a stack of up to three notices, and error boundaries (Reload, Try again / Close tab).
- **Batch 4 — workflow** (t-a35b, #365): New session can run in a new managed worktree; comment on
  diff lines and send the comments to the agent as one message; a Unified / Side-by-side diff
  toggle; a non-destructive Files context menu (open, copy path / relative path / name); PNG, JPEG,
  GIF and WebP previews up to 1 MiB in the file tab (gateway `workspace.files.preview` narrowed to
  raster images under `files.read`; owner `host.files.preview`). **No git or file write action was
  added** (commit, stage, discard, create, rename, delete stay with the agents; batch 5 is
  deferred).

Fixes since beta.10 include: a catalog rename that cannot be written to a session leaves it as its
disk has it (a160d6f6, 9fcf1495); Mark as unread stays on closed roots (e6464fd8); owner library
pages work in a workspace that is not an ALP project (570241c0); an address typed before a Browser
tab is ready loads once it is (fc8b48fa); the desktop e2e no longer hangs on a busy Browser spec or
a slow bundled page (d57f2533, fa54f98c, 2c8f10e0).

Known issues, carried from beta.10:

- **R1 (Codex) of the real-provider gate does not pass** (t-beb5), as in beta.9 and beta.10.
- **Paseo 0.16 and later** (t-1af7): the plugin fails to typecheck against the newest Paseo SDK.
- **Two alpd supervisors:** the Paseo plugin and `alp dashboard` each restart a crashed alpd with
  their own entry, so after a crash the alpd build can change to whichever restarts first.
- Windows keeps alpd on the bundled Node; npm installs always run alpd on Node. The desktop app is
  macOS only, not notarized, has no auto-update, and does not stop `alp dashboard` when it quits.
- Still as before: the Claude Agent SDK's own bundled zod is inside the advisory range (accepted
  residual risk, [zod-advisory.md](zod-advisory.md)); Antigravity's own read tools are not confined
  to the workspace; remote mode (`@anhlp/alp-gateway`) is not published.

# ALP 0.0.1-beta.10 — release notes

Prepared 2026-11-21 from the commits `v0.0.1-beta.9..ddd8ac80` (task t-81b0.10 bumped the version
and added the desktop app to the release). npm (8 packages, `beta` tag) and the GitHub release carry
the same version from one main SHA, as in beta.9. New in this release: the GitHub release also
carries the macOS desktop app as two DMGs. Release acceptance runs the repository's fake Codex and
fake Claude on the packed tarballs; macOS decides it, Linux and Windows are reported. **The gate's
real-provider rows (§6.1 of [beta-scope.md](beta-scope.md)) had not been run for beta.10 when these
notes were written;** none of them is claimed as passed here. The known R1 (Codex) failure from
beta.9 is unchanged (below).

**Upgrading from beta.9:**

1. `alp update` (bundle) or `npm install -g @anhlp/alp@beta` (npm), then `alp daemon restart`.
2. If `install.sh` of beta.8 or beta.9 created your `~/.alp` on a fresh machine, it is `0755` and
   alpd refuses it (`ALP_HOME_UNUSABLE … must be 0700`). Run `chmod 700 ~/.alp` once. beta.10's
   `install.sh` does not change the mode of an existing home; it prints a warning with that command.

Changes that affect an existing user:

- **The macOS desktop app is published.** The GitHub release carries `ALP-0.0.1-beta.10-arm64.dmg`
  (Apple Silicon) and `ALP-0.0.1-beta.10-x64.dmg` (Intel), built by the release workflow from the
  same main SHA as the archives, with their checksums in a separate file, `DESKTOP-SHA256SUMS`, and
  build-provenance attestations like the archives (`gh attestation verify ALP-0.0.1-beta.10-arm64.dmg
  --repo phucanh08/alp`). `SHA256SUMS` still lists only the ALP archives and installers, so
  `install.sh`, `install.ps1` and `alp update` read it as before. The DMGs are **ad-hoc signed and
  not notarized** (no Apple Developer ID), so macOS Gatekeeper blocks the first open of the
  downloaded app: on macOS 14 and earlier, Control-click (right-click) `ALP.app` › Open; from
  macOS 15, open it once, choose Done, then System Settings › Privacy & Security › Open Anyway. Or,
  after checking the DMG against `DESKTOP-SHA256SUMS` (and its attestation), remove the quarantine
  attribute: `xattr -dr com.apple.quarantine /Applications/ALP.app`. The app is a thin Electron
  shell over the `alp dashboard` you run; `alp desktop` opens it from `/Applications` or
  `~/Applications` ([desktop.md](desktop.md) §6, §7, §8).
- **The desktop app offers to install ALP when it finds none** (t-81b0.8, decision D35). It reads
  only the latest release's `SHA256SUMS`, shows the version, source, archive, checksum and every path
  (`~/.alp/app/<version>`, `~/.alp/bin/alp`, the ALP home), and writes nothing until you choose
  Install. It then runs the `install.sh` it was built with (`--no-modify-path`: no shell profile is
  edited). It installs the **latest** release, which may be newer than the app; an `alp` older than
  beta.9 already on the machine is not replaced (the app says how to update it). **Provenance limit:**
  the archive is checked only against the release's `SHA256SUMS` (by `install.sh`, downloaded again
  over HTTPS at install time) and by the versions its binaries report. The app does **not** verify
  the GitHub attestation: anyone who can change the release can change `SHA256SUMS` too. The
  confirmation page shows the `gh attestation verify` command to run yourself
  ([desktop.md](desktop.md) §3.2).
- **`install.sh` creates a missing ALP home `0700`** (t-66a4). Before, on a fresh machine it made
  `~/.alp` (or `$ALP_HOME`) under the umask, usually `0755`, and alpd refused to start until you ran
  `chmod 700`. Now, when the install puts files in the ALP home and the home does not exist, it is
  created `0700`. **An existing home keeps its mode:** if it is readable or writable by others,
  `install.sh` only prints `alp-install: warning: … Fix it with: chmod 700 '<home>'` (see Upgrading
  above). `--system`, or a `--root` outside the ALP home, creates no home. `install.ps1` is
  unchanged (Windows does not check the mode) (336510ec, 18d927c3).

Known issues, carried from beta.9:

- **R1 (Codex) of the real-provider gate does not pass** (t-beb5): the answer `alp run` prints for
  C4 is main's reply to the supervisor's check-in, so C8 cannot be judged; the same on beta.8.
- **Paseo 0.16 and later** (t-1af7): the plugin fails to typecheck against the newest Paseo SDK, and
  the all-workspaces terminal list of Paseo 0.16 may not show ALP's terminals. Per-workspace terminal
  lists are not affected. Not verified on a live Paseo 0.16.
- **Windows keeps alpd on the bundled Node**; the native alpd is macOS and Linux only. npm installs
  always run alpd on Node.
- The desktop app is macOS only, not notarized, has no auto-update, and does not stop
  `alp dashboard` when it quits.
- Still as in beta.9: the Claude Agent SDK's own bundled zod is inside the advisory range (accepted
  residual risk, [zod-advisory.md](zod-advisory.md)); Antigravity's own read tools are not confined
  to the workspace; remote mode (`@anhlp/alp-gateway`) is not published.

# ALP 0.0.1-beta.9 — release notes

Prepared 2026-11-20 from the commits `v0.0.1-beta.8..07569e38` (task t-81b0.6 bumped the version).
npm (8 packages, `beta` tag) and the GitHub release carry the same version from one main SHA, as
in beta.8. Release acceptance runs the repository's fake Codex and fake Claude on the packed
tarballs; macOS decides it, Linux and Windows are reported. **The gate's real-provider rows
(§6.1 of [beta-scope.md](beta-scope.md)) were run in part, on macOS, on tarballs packed from the
release candidate (commit 26c50065, before merge), with `--unattended` judging the steps a person
would read:** R2 (Claude, C1–C9) passed; R7 on macOS (real worktrees and `alp_merge`, Codex and
Claude) passed; **R1 (Codex) did not pass**: in two runs C8 could not be judged, because the
answer `alp run` printed for C4 was main's reply to the supervisor's check-in instead of the
answer to the question, and in the second run C6 failed (`alp run` ended before a permission
question). A control run of R1 on the published beta.8 tarballs shows the same C4 answer (a reply
to the supervisor), so that is not new in beta.9. R5 (the Paseo plugin, which needs a person and Paseo 0.11.x) and the Linux rows R3, R4,
R6 and R7's Linux half were not run.

**Upgrading from beta.8:**

1. **Windows only, before you upgrade:** if `alp web` is running, stop it yourself. alp never
   stops a running `alp web` on Windows: while it holds its lock, `alp dashboard`,
   `alp dashboard rotate` and `alp dashboard --stop` refuse and move nothing (`--status` says that
   `web.lock` is held and alp does not stop it on Windows). Its pid is in `%USERPROFILE%\.alp\web.json` (or
   `$ALP_HOME\web.json`): `taskkill /F /PID <pid>` (`/F`: it has no window to close). beta.8 has no
   command that stops `alp web`.
2. `alp update` (bundle) or `npm install -g @anhlp/alp@beta` (npm), then `alp daemon restart`.
3. Run `alp dashboard` once: it moves `alp web`'s token, port and settings to the new names (below).
4. If alpd runs as a launchd or systemd service (`alp daemon install`), run `alp daemon install`
   again on macOS or Linux to switch the service to the native alpd. Without it the service keeps
   running alpd on the bundled Node, which still works.

Changes that affect an existing user:

- **`alp web` is now `alp dashboard`; `alp web` is gone, with no alias.** The subcommands moved
  with it: `alp dashboard rotate`, `alp dashboard pair [--on|--off]`. New options, after Hermes'
  `hermes dashboard`:
  - `--status` says whether the service runs (pid, address without the token, port). It changes
    nothing and always exits 0.
  - `--stop` stops the service of this ALP home (exit 1 when the lock is held by a process alp
    cannot prove is the service). On Windows alp stops no process, so `--stop` refuses there too;
    end the pid in `dashboard.json` with `taskkill /F /PID <pid>`.
  - `--port N` uses that port for this run without changing `dashboard.port`. It is refused while
    the service runs on another port.
  - `--host` accepts only `127.0.0.1` or `localhost`. The service listens on loopback only, because
    its token is the only key; for another machine use an SSH tunnel.
  - `--no-open` and `--print` both print the address and do not open the browser; `--print` is
    the one the desktop app runs.

  Details: [dashboard.md](dashboard.md) §3.1 (c31e385f, 76ad5ec2, 2f47e5a0, 382651ac).
- **The first `alp dashboard` moves what `alp web` left.** `alp dashboard`, `alp dashboard rotate`
  and `alp dashboard --stop` first move a beta.8 home to the new names, keeping the token, the port
  and the on/off setting: on macOS and Linux a running `alp web` is stopped (only when alp can prove
  the process is `alp web`; otherwise nothing moves and the command says why), `~/.alp/web/` becomes
  `dashboard/`, `web.json` becomes `dashboard.json`, `alp-web.log` becomes `alp-dashboard.log`, and
  `web.enabled`, `web.port` and `web.permissions` in `settings.json` become `dashboard.*`
  (`web.relay`, Paseo's, stays). Running it again does nothing; when both names exist the new one
  wins and the old one is left as it is. `--status` moves nothing: it lists what the next start
  would move. The new names are the `dashboard.enabled`, `dashboard.port` and
  `dashboard.permissions` settings and the `ALP_DASHBOARD_*` variables; `web.*` settings and
  `ALP_WEB_*` variables are still read where the new ones are not set (c31e385f, 76ad5ec2).
- **The bundle's alpd is a native executable on macOS and Linux.** The GitHub release bundles for
  darwin-arm64, darwin-x64, linux-x64 and linux-arm64 add `bin/alpd`, alpd compiled with Bun 1.4.2
  (`bun build --compile`; the Bun runtime is downloaded from Bun's release and checked against
  pinned sha256 values). `alp daemon start`, `alp daemon restart`, `alp dashboard` and
  `alp daemon install` start it. The `alp` command, `alp dashboard`, the ACP agent and the MCP
  bridges keep running on the bundled Node, and everything alpd runs as JavaScript (a JavaScript
  `claude`, the `node -e` bridges) runs under the bundled Node too. `alp daemon run` still runs
  alpd in its own Node process. Unchanged:
  - **Windows** keeps alpd on the bundled Node in this release.
  - **npm installs** always run alpd on Node.
  - **Services installed before beta.9** keep running `node alpd.js` until you run
    `alp daemon install` again.

  `install.sh`, `alp update` and the build run `bin/alpd --version` first and refuse a bundle whose
  native alpd cannot run on this machine (an old CPU or glibc, a quarantined file), changing
  nothing. On such a machine set `ALP_NATIVE_DAEMON=0` and keep it set: the check is skipped and
  alpd stays on the bundled Node. Details: [binary-install.md](binary-install.md#the-native-alpd-t-81b09)
  and decision D34 (bd4d2220, 2e3f2d1b, ec3f6e4a, c386b9fa, 07569e38).
- **`alp desktop`** opens the ALP desktop app: `ALP.app` in `/Applications`, then
  `~/Applications`, only when its bundle id is `com.anhlp.alp.shell` (another app with that name is
  skipped with a `Skipped <path>: its bundle id is …` line), else the app built in the checkout
  `ALP_DESKTOP_CHECKOUT` names. Without either it prints how to get one and exits 1
  ([desktop.md](desktop.md) §7; c31e385f, 50644f7f).

Not in this release:

- **The desktop app (`ALP.app`, macOS) is not published.** No DMG is attached to the GitHub release
  or put anywhere else. CI builds two ad-hoc signed DMGs (arm64, x64) as workflow artifacts, kept
  14 days, for testing only; they are not notarized. So `alp desktop` finds an app only if you
  built it yourself from a checkout (`apps/desktop`, [desktop.md](desktop.md)) or took a CI
  artifact. The app is a thin Electron shell over the `alp dashboard` you already run: it reconnects
  when the dashboard restarts, moves port or rotates its token, and tells an `alp` too old for
  `alp dashboard` (beta.8 and earlier) to update (PRs #337, #338, #339, #341, #342). Publishing
  it, and installing a missing ALP from the app, come in a later release.
- Native alpd on Windows (see above).
- **Paseo 0.16 and later:** the plugin fails to typecheck against the newest Paseo SDK (0.16.2;
  failing since 0.16.0, 2026-11-16, and beta.8 the same way). Paseo 0.16 lets a client ask for the
  terminals of every workspace at once, without a working directory, and the plugin refuses a
  terminal request without one, so the all-workspaces terminal list may not show ALP's terminals.
  Per-workspace terminal lists are not affected. Not verified on a live Paseo 0.16.
- Still as in beta.8: the Claude Agent SDK's own bundled zod is inside the advisory range (accepted
  residual risk, [zod-advisory.md](zod-advisory.md)); Antigravity's own read tools are not confined
  to the workspace; remote mode (`@anhlp/alp-gateway`) is not published.

# ALP 0.0.1-beta.8 — release notes

Prepared 2026-11-07 from the commits `v0.0.1-beta.7..a711dcd` (task t-a178 bumped the version).
npm (8 packages, `beta` tag) and the GitHub release carry the same version from one main SHA, as
in beta.7. **The gate's real-provider rows (§6.1 R1–R7 of [beta-scope.md](beta-scope.md)) were not
run for this release; they are recorded as waived, not as passed.** Release acceptance runs the
repository's fake Codex and fake Claude on the packed tarballs; macOS decides it, Linux and
Windows are reported.

**Upgrading from beta.7:** `alp update` (bundle) or `npm install -g @anhlp/alp@beta` (npm), then
`alp daemon restart`. Then run `alp upgrade` in each project to receive the new `ALP.md` (see
*Vietnamese instructions* below). Users of beta.5/6 still rerun the installer, as for beta.7.

Changes that affect an existing user:

- **A target's model profiles are now an allowlist, also when there is only one.** Before, a
  target with exactly one model profile took any model a coordinator passed. Now the profiles
  that name a model (or `provider:*`) are the allowlist for every delegation target: main or lead
  cannot pass a model outside them. The refusal lists the allowed models (with one profile, leave
  `model` out) and says where to widen the list: `team.<teamId>.<agent>.profiles` in
  `<root>/.alp/settings.json`, a `provider:*` wildcard, and, for a Claude or Codex model in Phở or
  Cafe, `alp setup <root> --runtime mix`. The effort is now checked against the model for every
  target with profiles. An effort ALP cannot check (`antigravity:`, `acp:`, a model listed without
  efforts) is passed on, and the answer says it was not checked. Oracle is unchanged. In
  practice: `alp init` gives lead, peer and reviewer one profile each, main's model. So a main
  started on Codex with `--model codex:…` in a project set up for Claude can no longer move peer
  or reviewer to Codex by passing a model. Run `alp setup --runtime codex` or `--runtime mix`, or
  add a Codex profile (65702004, 80ba6253, be083bfc).
- **`alp setup` keeps profile lists you wrote by hand.** It rewrites only entries ALP wrote: the
  template's defaults, or its own earlier output, which it now records in
  `<root>/.alp/state/setup-profiles.json` (Git ignores that directory, so the record is per
  checkout). Without a record, an entry that matches one of setup's defaults counts as setup's.
  Any other entry is kept, and so is one whose model or effort a library or project override of
  Phở or Cafe sets in its `team.json`. Setup prints a `Kept team.<team>.<agent>.profiles …` line
  for each, saying why. Teams other than Phở and Cafe are no longer skipped silently: setup names
  each one and the `team.<id>.<agent>.profiles` key to edit. Single-provider and mix output for Phở
  and Cafe is unchanged (60f8ccf8, b056ad88, 20957f4e).
- **Vietnamese instructions.** The shipped templates are now in Vietnamese: the six built-in
  agents' `AGENT.md`, the Phở and Cafe house rules, `ALP.md`, the core skills, and the optional
  packs with their agents and the Blueprint team. Identifiers stay English: file and skill names,
  JSON keys, role and team ids, `alp_*` tools, commands, and the labels inside code fences
  (1f827c6, a4fecefd, d26f6413). `alp language` still sets only the language agents use when
  they write to you; it does not choose the language of the instructions. What happens to what you
  already have:
  - Built-in agents and the Phở/Cafe teams are read from the installed ALP. They switch to
    Vietnamese as soon as you update. An override in `~/.alp/` or `.alp/` (`alp team edit`, an
    agent of the same name) holds its own copy of the files, written when you made it, and stays
    in English.
  - Library skills in `~/.alp/skills` and `role-skills.json`: a file still exactly as ALP wrote it
    (checked against `~/.alp/library.json`) is replaced by the new version on the next session
    open or `alp init`/`alp upgrade`, without a backup (`alp init`/`alp upgrade` print how many
    files they updated; a session open prints nothing). A file you edited is kept as it is, in
    English. A shipped file you deleted stays deleted.
  - A project's `ALP.md` changes only with `alp upgrade` (alias `alp update-template`). If it is a
    copy of any `ALP.md` ALP shipped and you never edited it, it is replaced by the Vietnamese one
    and the old file goes to `.alp/backups/upgrade-*/`. If you edited it, it is kept, and the
    command prints `Custom instructions preserved; reconcile with templates if needed: ALP.md`.
    Until you run `alp upgrade`, an unedited English `ALP.md` stays in English.
  - Project copies of built-in agents (`.alp/agents/<role>/AGENT.md` from older scaffolds),
    with `alp upgrade`: an unedited copy with nothing added is backed up and removed, so the
    built-in applies. An unedited copy you added skills, MCP servers or hooks to keeps them, and
    only its `AGENT.md` is replaced (with a backup). An edited copy is kept and listed under custom
    instructions. Until then, such a copy overrides the built-in, in English.
  - "Unedited" means byte-for-byte one of the versions ALP shipped (line endings aside). Every
    released `ALP.md` and every version of the six agents' `AGENT.md` is now listed, so no copy
    from an earlier release counts as edited by mistake (b60d118b, d5a8738f, 80ba6253).
- **Antigravity read-only allows only `pwd` in the terminal.** In beta.7 it also allowed `ls`,
  `cat`, `head`, `tail`, `wc` and `grep`. agy matches allow rules by command prefix, so `ls` also
  let `ls ~/.ssh` run. agy's own file reading, listing and search tools still work, and are not
  kept inside the workspace (f0d193b0, 36c96a89). The provider setting `readOnlyMode` and
  `alp provider edit --read-only-mode` are removed: an old provider file still loads with a
  warning, and saving it drops the key (6367aac8).
- **Advisors and reviewers are read-only by role.** A team member that serves as an advisor or
  reviewer is capped at read-only, whatever its profile, `agent.json` mode or the caller asks,
  and this now applies to custom teams too, not only to the built-in names (27e849d3).
- **Claude: `/clear`, `/new` and `/reset` are refused.** On Claude they start a new native
  conversation while ALP keeps the old thread, so resume, fork and rewind went back to the old
  conversation. They are now refused, with the way out (a new ALP session, or compact), and hidden
  from the composer. A scheduled one fails with the reason instead of being recorded as
  delivered. A custom `/new` or `/reset` of your own is offered and passed on (1fd1f0b1, 54121ee4,
  c3216ebd, 59b4002d).
- **More is reserved for the user.** alpd refuses a connection an agent opened (one that announces
  `ALP_AGENT_SESSION`) for `session.fork`, `session.rewind`, `session.reload`,
  `session.compact` and `extension.register`. Every `alp web` command refuses to run from an agent
  process. The Paseo plugin stops (exit 1) instead of retrying when it was started from an agent's
  shell (42a5466d, e65bc70f, b1eefc89, 3580e8a6, 16b8200e).
- **`install.sh --root DIR` without `--dir` installs the command in `DIR/bin` and edits no shell
  profile** unless you add `--modify-path` (Windows: `install.ps1 -Root`, `-ModifyPath` or
  `ALP_INSTALL_MODIFY_PATH=1`). An empty, self-owned `ALP_HOME` you created with mode 0755 is
  tightened to 0700 instead of being refused (606ae983, 87c9399f).

Also new or fixed:

- **Skills:** seven new core skills (skill-authoring, architecture-docs, feature-architecture,
  test-strategy, safe-refactor, security-review, release-readiness). An unedited
  `role-skills.json` gets them automatically. `alp upgrade` adds them once to an edited one and
  says so; remove any you do not want, and it will not add them again (18fb6c4f, ae035dd8).
  Also `alp skill check` and a skill-format check in `alp doctor` (c0d5700d); optional packs
  with `alp packs` and `alp pack install <id>`, including the architecture pack with its
  Blueprint team (b49fcd6a, 7ccc2725). Main can propose retiring a library skill with
  `alp_skill_retire`: nothing moves until you approve the card, the skill is kept in
  `~/.alp/retired-skills`, and `alp skill restore` / `alp skills --retired` bring it back
  (39d3ae60, c5c8729f, 87e54847, 03ddac04). `alp skill new` now refuses a skill that fails the
  strict format (6775bde3), and `alp skill cp` copies the whole skill directory (8503b1a7).
- **Compact** from the web app and Paseo (ae035dd8), and ALP's compact prompts no longer appear as
  your messages in the timeline (b25096a8).
- **Models:** ACP providers are listed without being started at alpd start (5a64780b, 83473d6f).
  The CLI checks an effort against alpd's cached model list, as alpd does (bb11346f).
- **alpd** waits 60 s to start (was 15 s), set with `ALP_DAEMON_START_TIMEOUT_MS` (c3cac442).
  `alp doctor` classifies leftover worktrees and `alp-*` temp directories, and suggests a removal
  command only for a clean, pushed one with no ignored files (5658dff6, da2dc508, 9eb8ce75,
  e976de45). A full disk holds work at once instead of at the next check (5658dff6).
- **Windows:** the Git status and diff alpd shows (web app, Paseo) no longer list files behind an
  untracked junction or directory symlink, which reached outside the checkout (a31dced2,
  1ac39940). ConPTY terminals report the shell's real pid and close only after the shell has
  exited (2858bbee, 9a4f3ab0). The Paseo plugin finds alpd behind npm's or `install.ps1`'s
  `alp.cmd` (8d51121a). `alp update` can reinstall the running version (9301010e). `install.ps1`
  waits out a short hold on a version directory before refusing, and its refusal names what holds
  the directory (51360066, 9777f168).
- **Security:** zod is pinned to 4.6.7 in ALP's own manifests (was 4.4.3), for
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (HIGH: memory
  exhaustion on oversized capped arrays, maps and sets). `npm audit` of ALP's lockfile, which
  covers the packages ALP declares, goes from 1 HIGH (zod) at beta.7 to 0 (89316904;
  [zod-advisory.md](zod-advisory.md)); it does not see the SDK's bundled copy (below). The release and CI
  scripts run Windows' own `tar.exe` on Windows instead of the one first on `PATH`. Under Git Bash
  that was GNU tar, which reads `C:\…` as a remote `host:file` archive. This changes nothing for
  an installed ALP: `alp update` already used the system tar (c53c3da6, ef18d4da, 01f28b98).
- Tests and CI: hermetic test runs, per-file hang dumps and a teardown-order lint (53578385,
  b125cc57, 67052d0e and their follow-ups).

Not in this release:

- **The Claude Agent SDK's own bundled zod is still inside the advisory range.** ALP cannot pin it,
  so it ships unpatched. The user accepted this as a residual risk on 2026-11-06 (board decision
  p-3f3a8f96), with the conditions for reopening it in [zod-advisory.md](zod-advisory.md)
  (eefc4989, 934d9642).
- Antigravity's own read tools are still not confined to the workspace, and a read-only reviewer
  on Antigravity cannot run tests or `git diff` (36c96a89, 6367aac8).
- Remote mode (`@anhlp/alp-gateway`) is still not published.

# ALP 0.0.1-beta.7 — release notes

Prepared 2026-10-31 (tasks t-1807, t-7933). The first release shipped as the Node bundle; GitHub
release and npm (8 packages) carry the same version from one main SHA.

- **Users of 0.0.1-beta.5 or beta.6 must rerun the installer**; see *Upgrading from
  0.0.1-beta.5/6* below. `alp update` from beta.5/6 cannot install beta.7.

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
  [dashboard.md](dashboard.md#31-alp-dashboard-trên-máy-này-alp-dashboard), [beta-install.md](beta-install.md#alp-dashboard-on-this-machine).
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
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (historical: prompt-only read-only; current native session modes are described in README) | — |
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
