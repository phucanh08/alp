# ALP prototype

Provider-neutral filesystem agent resolution with a server-side Paseo provider. Includes project initialization and the existing Phases 2–5 prototype. Editors that speak the Agent Client Protocol use ALP through `alp acp`.

## Install

The current release is the beta `0.0.1-beta.3` (until it is on npm, `@beta` installs
`0.0.0-beta.2`; check with `npm view @anhlp/alp dist-tags`): see the
[release notes](docs/alp/beta-release-notes.md) for what it includes and its known issues, and
[installing, upgrading and removing the beta](docs/alp/beta-install.md) for every step. Name the
beta when you install (`@beta`, or exactly `@0.0.1-beta.3`); a plain `npm install -g @anhlp/alp`
installs whatever npm's `latest` tag points at, which moves to a new beta only after that
beta's post-publish checks.

Supported: Linux or macOS, Node.js 22 (22.12 or later) or 24, and a signed-in Codex CLI or
Claude Code on PATH. Windows and Node.js 26 are experimental; Node.js 20 is not supported.

```sh
npm install -g @anhlp/alp@beta
alp doctor          # checks Codex and Claude, settings, and leftovers; --fix repairs the safe ones
alp daemon start
```

Choose the models Phở and Cafe run on in a project, for Codex only, Claude only, or a mix:

```sh
alp setup                              # select boxes: runtime, which provider first, then Save / Change a model
alp setup --runtime codex              # Codex only
alp setup --runtime claude             # Claude only
alp setup --runtime mix                # both, Claude first
alp setup --runtime mix --prefer codex --codex-model gpt-6-sol --claude-oracle claude-fable-5-1
```

Setup writes `team.pho` and `team.cafe` into the project's `.alp/settings.json`
(running `alp init` first when there is none) and keeps the rest of the file. Main runs
on one model, of the preferred provider. Lead and reviewer take `--claude-model` /
`--codex-model`, the supervisor `--claude-supervisor` / `--codex-supervisor`, and the
oracle `--claude-oracle` / `--codex-oracle`; in mix each lists both providers, the
preferred one first, and an only mode lists its own. Peers get `claude:*` and/or
`codex:*`: any model of the enabled providers, chosen with its effort for each task by
whoever assigns it. Defaults: Opus 5.5 / GPT-6.1 Sol at high, Sonnet 5 / GPT-6 Luna at
medium, Fable 5.1 at high / GPT-6 Astra at low (the only effort it takes). Setup does
not install CLIs, log in or call models: run `alp doctor` for that. New sessions use
the profiles; running sessions keep theirs.

The package provides the `alp` command and `alpd`, the per-user daemon that runs ALP sessions. To view and drive sessions in Paseo, also install the [Paseo plugin](integrations/paseo/README.md).

## Initialize a project

Run `alp init [directory]` (or `node /path/to/alp/packages/cli/dist/cli.js init [directory]` when running a source checkout after `npm run build`). The directory defaults to the current working directory.

When the Paseo plugin opens an ALP session in a repository that lacks `ALP.md` or `.alp/settings.json`, it performs this initialization automatically. Initialization fills missing scaffold files and never replaces existing files, so partial and customized ALP setups are preserved.

Initialization creates `ALP.md` and `.alp/settings.json`. The six agents `main`, `lead`, `peer`, `oracle`, `reviewer` and `supervisor` are built into ALP and follow its updates; a project does not copy them. To change one, make an agent of the same name in your library (`~/.alp/agents/`) or in the project (`.alp/agents/`); see [agent library](docs/alp/agent-library.md). Main owns delivery; Phở lets main implement or call peer, while Cafe assigns technical execution to lead. Oracle and reviewer provide read-only advice and review; the supervisor reviews main's process after each turn.

The default settings select main with the Phở team. Main runs on Opus 5.5 with high effort and full access unless settings or the caller choose otherwise. Paseo exposes an `alp_delegate` tool that executes real child sessions and returns their evidence. See [Phở and Cafe teams](docs/alp/team-workflow.md).

Six [role skills](docs/alp/role-skills.md) cover intake, research, planning, delegation briefs, bug diagnosis, and commit packaging. They live in your skill library in `$ALP_HOME` (default `~/.alp`), seeded on first use, together with `role-skills.json`, which assigns six to main, five to lead and three to peer. Edit either freely: app updates replace only library files you have not changed. Each agent selects directly from its skills and loads contents only when needed.

Repeated runs fill in missing files and preserve existing file contents, including custom settings. Conflicting filesystem entry types cause an error; files already created before an error remain available for a later retry. Run `npm run test:init` to verify initialization independently.

For projects created with an earlier scaffold, run `alp upgrade [directory]` (or the built CLI above). This backs up and updates recognized original instructions, adds team settings, renames the old `smart`/`supervised` profiles to `pho`/`cafe`, and archives project copies of skills that still match the shipped ones, so the library applies. Copies of the built-in agents that are still as ALP shipped them are put away too, so the project uses the built-ins; a copy you edited, or added skills, MCP servers or hooks to, stays as the project's override. The old shipped graph migrates to Cafe; custom graphs and customized instructions/skills remain unchanged.

## Development

Use Node 22 (22.12 or later) or 24 and an npm version compatible with your Node installation:

```sh
npm ci
npm run check
npm test
```

`npm test` builds every workspace and runs the hermetic suites (unit and integration together, each file once) in a throwaway `ALP_HOME`. `npm run build` builds only the core CLI, daemon, ACP and runtime bundles; `npm run build:paseo` builds the optional plugin. The runtime in `packages/runtime/src` owns native harnesses, sessions, delegation, and mail without importing Paseo; `alpd` hosts it, and the plugin is a viewer over the daemon ([design](plans/reference/ALPD.md)).

Tests are split by owner:

| Group | Location | Run |
| --- | --- | --- |
| Unit and package-level contract | `packages/<name>/tests/` (plugin: `integrations/paseo/tests/`) | `npm test -w @anhlp/alp-core` (or `-runtime`, `-client`, `-daemon`, `-cli`, `-protocol`, `@anhlp/alp-paseo`); all at once: `npm run test:unit` |
| Integration (several packages, CLI processes, repository checks) | `test/integration/` | `npm run test:integration` |
| E2E (live providers, opt-in) | `test/e2e/` | `npm run test:e2e` or one of `test:e2e:*` |
| Shared fixtures such as fake transports | `test/support/` | imported by package and integration tests |

`npm test` runs unit and integration; `npm run test:all` adds E2E. A package test imports only its own package and the packages it declares as dependencies; `npm run check:boundaries` and `test/integration/layout.test.js` enforce that. The core packages (protocol, core, runtime, client, daemon, cli) test without installing Paseo.

Runtime tests drive scripted agents from `test/support/fake-agent.js` instead of Codex or Claude: they call ALP tools, report context fill, hand off slowly, crash mid-turn or hit a usage limit on cue. `packages/client/tests/golden.test.js` compares what `alp log`, `alp ps` and `alp task report` print with `packages/client/tests/golden/*.txt`; after checking an intended change, accept it with `ALP_UPDATE_GOLDEN=1 npm test -w @anhlp/alp-client`.

## Project files

```text
your-project/
  ALP.md
  .alp/
    settings.json
    tasks/            # one JSON file per task; commit it with the project
    agents/           # optional: project agents, and overrides of built-in or library ones
      your-agent/AGENT.md
      your-agent/agent.json
    skills/ mcp/ hooks/   # optional: project entries; each overrides a library entry of its name
```

`alp agents`, `alp skills`, `alp mcp` and `alp hooks` list what a project can use: ALP's built-ins, your library in `~/.alp`, and the project's own entries, with what each overrides and which agents use it. `alp agent|team|skill|mcp|hook new|edit|cp|mv|rm` change them, in your library or with `--project` in the project, and `alp mcp test` and `alp hook test` try one out ([editing](docs/alp/agent-library.md#editing)).

`alp init` now writes editable `team.pho` and `team.cafe` choices into
`.alp/settings.json`, taking a snapshot of your current user team configuration.
`alp upgrade` migrates the old `profile` key to `team` and adds these team settings to older projects, backs up the settings it changes,
and converts earlier single-model choices to lists without changing their values.
Every agent (main, lead, peer, reviewer, supervisor, oracle, or a custom member) has
`profiles`: a list of `"provider:model:effort"` (the effort may be left out), or
`"provider:*"` for any model of that provider. Main and oracle name their models, and
main runs on exactly one. Include both providers for dual-lens oracle advice:

```json
{
  "workflow": { "mode": "cafe", "maxPeers": 2 },
  "team": {
    "cafe": {
      "main": { "profiles": ["claude:claude-opus-5-5:high"], "autocompact": "auto" },
      "lead": { "profiles": ["claude:claude-opus-5-5:high", "codex:gpt-6.1-sol:high"] },
      "peer": { "profiles": ["claude:*", "codex:*"], "autocompact": 200000 },
      "oracle": { "profiles": ["claude:claude-fable-5-1:high", "codex:gpt-6-astra:low"] }
    }
  }
}
```

An agent that runs by itself (main, the supervisor) starts on its first profile, at its
effort or else its team's. When main or lead assigns work to an agent with several
profiles or a `provider:*`, such as a peer, it picks a model they offer and an effort
that model takes for each task, by its difficulty, risk and the autonomy it needs, and
says why; a listed effort is only the usual one. ALP refuses an assignment without both
or with a model they do not offer. An agent with one named profile runs on it. A list
does not enable automatic fallback. Oracle still requires an explicit lens selection.
An effort a model does not take is refused (GPT-6 Astra takes only low). The earlier
form, `{ "provider", "model", "effort" }`, still works; `alp upgrade` rewrites it as
`"provider:model:effort"`.

`autocompact` belongs to the agent, beside `profiles`, and applies to every model in
its list. A whole number from 100000 to 1000000 requests compaction at that many tokens
on Codex, or sets Claude's native auto-compact window (Claude can compact earlier to
reserve response space). The model's capacity still applies. `"auto"` or omission
keeps the agent's existing native/context defaults. The same field is supported in
`agent.json`; a numeric project setting takes precedence. 200000 here is an example,
not a shipped default. New and upgraded configurations use `"auto"`.

Unspecified agents keep the team's choices. Explicit session/delegation model and
effort win, then project team choices, then the older `runtime` settings, then
team and agent defaults. Run `alp setup` again to rewrite Phở and Cafe's profiles, or
edit the file to change one agent. Only configured oracle lenses are available, and an
unavailable lens is reported rather than substituted.

Example `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "pho" },
  "runtime": { "provider": "codex", "model": "gpt-5.6-sol", "reasoning": "low" }
}
```

`workflow.mode` names a team: `pho`, `cafe` or your own (`smart` and `supervised`, Phở and Cafe's names before 0.4, are still accepted); `workflow.supervisor: false` turns the supervisor off. `runtime.provider` selects `codex` or `claude` behind the ALP Paseo plugin; the Paseo provider ID itself is `alp`. Without `runtime.provider` and `runtime.model`, main runs on `claude:claude-opus-5-5` with `high` effort; setting either replaces that default. `runtime.model` is passed through to the selected native harness, so it accepts any model name supported by that installed Codex or Claude Code version. Core treats these strings as provider-neutral data. An agent's `agent.json` can pick its own provider, model, thinking and mode, and name the skills, MCP servers and hooks it uses ([agent library](docs/alp/agent-library.md)). ALP runs hooks itself at its own events, the same for Codex and Claude; a project's hooks run after you trust the workspace once ([hooks](docs/alp/agent-library.md#hooks)). Besides Codex and Claude, an agent can run on any agent that speaks the Agent Client Protocol, such as Gemini CLI or opencode (experimental in the beta), added to your library with `alp provider add` or in the web app's Providers settings ([ACP providers](docs/alp/agent-library.md#acp-providers)).

For example, select Claude Code and one of its model aliases in `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "pho", "maxPeers": 2 },
  "runtime": { "provider": "claude", "model": "sonnet", "reasoning": "high" }
}
```

The Paseo model picker shows the teams, Phở and Cafe first; a session's model and effort follow from the team and are not chosen in Paseo. `runtime.model` in `.alp/settings.json`, or `--model` and `--thinking` on `alp run`, still override them. Those take runtime-prefixed IDs such as `codex:gpt-6.1-sol` or `claude:claude-opus-5-5`, or any native model name the installed Codex or Claude Code accepts.

`permissions` in `.alp/settings.json` (and in `$ALP_HOME/settings.json`) gives agents permission profiles with Claude Code-style rules. A profile caps an agent's mode, lets it run commands beyond that mode, asks you before others (`ask`, or `"beyondMode": "ask"` for anything the mode refuses), or refuses them in any mode. You answer Allow once, Always allow (written to the profile) or Deny, in Paseo or with `alp answer`. For example, a read-only reviewer may run the tests:

```json
"permissions": {
  "profiles": { "review": { "base": "read-only", "allow": ["Bash(npm test:*)"], "deny": ["Bash(rm:*)"] } },
  "agents": { "reviewer": "review" }
}
```

On Claude, read-only and workspace-write profiles also put Bash in the OS sandbox, so a read-only reviewer can run tests that only read. With `"workdir": "copy"` an agent works in a disposable copy of your tree, where it may build and test without touching yours. `alp permissions` shows each agent's profile, and `alp permissions check <agent> "<command>"` tests a rule. Details: [Permission profiles](docs/alp/team-workflow.md#permission-profiles).

Use `resolveAgent(projectRoot, { agent: 'your-agent' })` from `src/core/resolver.js` to resolve an agent without starting a runtime. Explicit selection overrides settings; missing settings default to `main`. There is no central agent registry.

## Daemon and CLI

`alpd` hosts ALP sessions for all projects of a user. After `npm run build`:

```sh
alp daemon start          # or: status [--json] | stop | restart | install | uninstall (install: experimental)
alp doctor [--fix]        # what ALP needs here, what earlier runs left behind, and what alpd's log and readiness say; only --fix repairs
alp backup --stop         # sessions, settings, library and the projects' tasks in one file; also: verify | list
alp restore FILE --stop   # checks the whole backup first, keeps what it replaces; --dry-run changes nothing
alp run --team cafe "Your task"      # streams the agent tree; Ctrl-C interrupts
alp ps [--all]            # live sessions as a tree; --all adds closed ones
alp top [session]         # live dashboard: who runs, who waits, questions, worktrees, leases
alp attach <session>      # follow a running tree, or print a closed one
alp send <session> "More context"   # resumes a closed root first; to an agent, mail from you
alp send <live-session> --prompt "Continue with this instruction" # explicit new prompt, including a recovery child
alp questions             # questions agents asked you
alp answer <question> "Your answer"   # or: --dismiss [--reason R]
alp log <session>         # delegations, mail, handoffs, worktrees, pins and questions of a tree
alp board [--project DIR] # the project board: claims, decisions and findings
alp tasks [ready]         # the project's tasks; ready: what nothing blocks
alp task add "Title" -p 1 --after t-91c2   # also: show | edit | close | reopen | dep
alp formula pour release --var version=0.4.0   # also: list | show; tasks export | import for beads
alp verify [--task t-77e0]   # run the project's verify commands; --task records the result
alp recall <assignment|task> "Why did you…?"   # ask a finished assignment about its work
alp pause [codex|claude] [--now]   # hold delegation; --now parks running assignments
alp resume [codex|claude]          # parked assignments continue
alp interrupt <session>
```

`alp send <child> --prompt <text>` explicitly prompts an existing live child and follows only its output. An active turn refuses this new prompt; default root send keeps its steering behavior. It does not replay the saved recovery continuation; supply the instruction you want it to follow. Existing queued mail is consumed by the ordinary runtime once. The existing runtime prompt rules remain authoritative; this command does not lift provider pauses. Default child `alp send` remains user mail and does not unpark manual recovery. `alp resume` only continues sessions parked for the matching provider or global pause; manual and legacy recovery need an explicit prompt.

You talk with main. Main can ask you a question with `alp_ask` without ending its turn; `run`, `attach` and `send` show it and, in a terminal, read the answer, and `alp answer` answers from anywhere by question id or a unique prefix. In Paseo the question appears as a question prompt. Other agents do not talk to you unless you write to them first with `alp send <agent session>`; ALP then tells the agent that assigned them, and they may ask you questions too.

Agents on one project share a board, even when they belong to different trees. Each one claims the paths it is about to change, and an overlapping claim from another tree is refused. Agents also pin decisions and findings, which reach other agents that are working and start every new assignment. `alp board` shows the board.

Each project keeps its tasks in `.alp/tasks`, one JSON file per task, modelled on [beads](https://github.com/gastownhall/beads): types, priorities 0–4, `blockedBy`, epic parents, and a ready list of open tasks that nothing blocks. Only you and main create or change tasks: you with `alp task`, main with its `alp_task` tool. Other agents read them and report work they find to their requester. Main gives a task to lead or peer with `alp_delegate { taskId }`: the task starts, its paths are claimed, and the handoff moves it to review until main accepts it. Each of main's turns starts with what waits for review and what is ready, and Paseo shows the tasks a session worked on as a task list. When every child of an epic is closed, main closes the epic, and you get a report of what it came to: tasks, time, rework and verification. `alp task report <epic>` shows it at any time.

A gate holds a task back until it clears:
- `human`: you approve it with `alp task gate clear` or in Paseo.
- `timer`: a time passes.
- `gh:pr`: a pull request merges.
- `gh:run`: a workflow run succeeds.

Formulas are workflow templates, as in beads: a `<name>.formula.toml` (or `.json`) file in `.alp/formulas`, `$ALP_HOME/formulas` or `.beads/formulas` lists steps with `needs` and `{{vars}}`. `alp formula pour release --var version=0.4.0`, or main with `alp_task pour`, turns one into an epic with a task per step; a `human` step waits for your approval. `alp tasks export` and `alp tasks import` move tasks to and from beads' JSONL (`bd export` / `bd import`, default `.beads/issues.jsonl`).

`alp tasks gates` and main's turns check the GitHub gates. `alp tasks compact` shrinks tasks closed more than 30 days ago. In Paseo, each workspace has a **Tasks** panel: you approve gates, add tasks, and accept or reopen them there. The CLI writes the files directly, so it works without alpd.

`ALP_HOME` selects the daemon's directory (default `~/.alp`); `ALP_RUN_LOG_DIR` overrides where assignment logs go (default `$ALP_HOME/runs`). alpd records sessions, their timelines, and prompt receipts under `$ALP_HOME/state`, project boards under `$ALP_HOME/boards`, and its own location in `$ALP_HOME/alpd.json`. After a restart, or a crash, a root can be resumed with `send` or imported into Paseo; work that was running is marked `daemon_restarted`. A task an assignment held goes back to open at main's next turn, with the branch that kept the assignment's work, and main's task list shows it as interrupted.

With `"verify": { "test": "npm test" }` (also `setup`, `typecheck`) in `.alp/settings.json`, alpd runs the project's checks itself:
- before `alp_merge` applies a worktree change; if they fail, nothing is applied and main can fix the change with `alp_delegate { continueFrom }`;
- in the checkout after a shared writer finishes;
- on demand with `alp_verify` or `alp verify`.

The result is recorded on the task, and an agent cannot close a task as done after a failed check without saying why. A timed-out command gets SIGTERM before SIGKILL, `idleSec` stops a silent one, and a step exiting 75 counts as could-not-run (skipped), not failed. Details: [Verification gates](docs/alp/team-workflow.md#verification-gates).

`alp_delegate { continueFrom: assignmentId }` also continues a finished Codex or Claude shared assignment while its record is retained (14 days). It creates a new assignment in the same checkout, carrying the previous brief and handoff, and preserves an external `writeRoot`. It does not reopen the old conversation or restore a file snapshot. Running or parked assignments must finish or be canceled first. Older records without this context can be continued by delegating again with their handoff; shared changes need no merge or discard.

When recovering an assignment saved by an older ALP version, an effort no longer accepted by the current model catalog falls back to that model's default. ALP tells the requester and records the change in the run log. Newly requested unsupported efforts are still rejected.

Text one agent wrote reaches another without `<system-reminder>` tags, so a peer cannot pose as the harness.

Work survives alpd: after a crash, `alp daemon stop` or `alp daemon restart`, the next alpd reopens trees that were working, by itself, and their assignments continue with their thread, worktree and task. When a Codex or Claude process dies under a session, ALP restarts it and the session continues; three restarts in a row with no progress end it. `alp daemon install` (experimental in the beta) runs alpd as a login service (launchd on macOS, systemd on Linux) that starts it again after a crash. Details: [Crashes and restarts](docs/alp/team-workflow.md#crashes-and-restarts).

`alp backup` writes your sessions, timelines, receipts, settings, library and the projects' tasks to one checked file, and `alp restore` puts them back only after checking all of it, keeping what it replaced so the restore can be undone; an interrupted restore is rolled back. alpd migrates an older state when an upgrade needs it, after saving a backup, and an older ALP refuses state a newer one wrote instead of changing it. Session trees unused for 30 days are deleted, but never while one of them is live or a prompt receipt of theirs (7 days) is still honoured. Codex and Claude keep their own threads, which a backup does not hold. Details: [Backups, restores, upgrades and recovery](docs/alp/data-recovery.md).

When a runtime hits its usage limit, ALP pauses it by itself. Assignments the limit stopped are parked instead of failed, and every open session shows a notice saying when the limit resets. Agents on the other runtime keep working. alpd asks the paused runtime every minute, and at once when an agent delegates to it. It resumes the runtime as soon as the runtime says the limit lifted, and the parked assignments continue. With `"limits": { "autoResume": false }` in `$ALP_HOME/settings.json`, ALP only tells you, and `alp resume codex` continues. Details: [Pause and usage limits](docs/alp/team-workflow.md#pause-and-usage-limits).

Agents and ALP write to you in the language set in Settings → ALP → General → Language, or with `alp language English`; unset, it is Vietnamese. That covers replies, questions, approval requests and notices. Details: [The user's language](docs/alp/team-workflow.md#the-users-language).

Finished assignments stay recallable for 14 days: main, or the agent that assigned one, asks it with `alp_recall` why it did something, and you ask with `alp recall <assignment|task> "question"`. ALP forks the assignment's session read-only, asks, and drops the fork; the question never changes the assignment's own session. ALP keeps the native threads of assignments for this, and deletes them after 14 days. The Paseo plugin keeps the same daemon running while Paseo runs: it starts alpd with Paseo and again whenever alpd goes down, except after `alp daemon stop`, and its sessions reconnect.

## The web app

`alp web` opens ALP's own web app (`apps/web`) on this machine. It ships in the CLI (`@anhlp/alp`, `@anhlp/alp-cli`); you do not need Paseo or its plugin:

```sh
alp web            # starts the alp-web service if needed and opens its address with its access token
alp web --print    # prints the address instead
alp web rotate     # replaces the access token; open pages lose access
```

`alp web` runs the `alp-web` service: one listener on `127.0.0.1` at `web.port` (default 7433; if it is busy, the next nine ports are tried) that serves the app's files and an embedded ALP gateway. The address is `http://127.0.0.1:<port>/#token=alpgw1.…`. The token is a gateway credential that alp-web keeps in `~/.alp/web/credentials.json`, apart from the standalone `alp-gateway` and its `credential list`. The page takes the token out of the address at once and keeps it only in that tab's session storage, so a reload reconnects and a new tab needs the link again. alp-web keeps alpd running (`ALP_SUPERVISE=0` turns that off) and records its pid, port and token in `~/.alp/web.json`.

- **What the token may do:** sessions, projects and adding projects (`session.read`/`write`, `project.read`/`write`, `workspace.write`). File reading, attachments, terminals and changing a live session's team are off until you add them: `"web": { "permissions": ["files.read", "attachments.write"] }` in `~/.alp/settings.json`. If one entry is not a permission, alp-web warns and ignores the whole list; an entry that is not a lowercase name with dots (such as `"files-read"`) makes the whole `settings.json` invalid, so both alpd and alp-web ignore all of it (alp-web's `web.port` included, alpd's own settings too) and log `ALP_SETTINGS_INVALID`.
- **Which projects:** the projects alpd knows, and the folder `alp web` ran in when it started the service, if that folder is an ALP project (it has `.alp/`). New projects are added while alp-web runs; open pages reconnect by themselves.
- **Settings:** `web.port`, `web.permissions` and `"web": { "enabled": false }` (turns `alp web` off). alp-web reads them when it starts; `alp daemon stop` does not stop it. To apply a change, stop the process whose pid `~/.alp/web.json` names (`kill <pid>` on macOS and Linux, `taskkill /PID <pid>` on Windows), then run `alp web`; `alp web rotate` also restarts it, with a new token.
- **Coming from the Paseo-based `alp web`:** the first `alp web` stops the old Paseo integration if it still holds `integrations/web.lock` (only when it is provably your process from this boot) and copies its token and server id to `~/.alp/paseo.json`, unless that file exists, so paired devices keep working.

The app's features and limits: [docs/alp/web.md](docs/alp/web.md). macOS is the primary platform. `alp web` is untested on Windows: CI runs its tests on Linux and macOS only (a Windows trial found credential-file writes failing now and then with `EPERM`). On Windows, `alp web rotate` and the upgrade takeover do not stop a running alp-web for you: end the pid in `~/.alp/web.json` (`taskkill /PID <pid>`) first.

### Paseo's app on your phone (experimental)

The optional `@anhlp/alp-paseo` package is the Paseo plugin and the Paseo integration, which runs as integration `paseo` (`~/.alp/integrations/paseo.lock`, `~/.alp/paseo.json`) on a port the system picks, never `web.port`. It no longer carries Paseo's web app: ALP's patched build of it (`paseo-web/`) was removed once `alp web` served ALP's own app (t-55ce.3). Relay pairing is experimental in the beta and off by default. The integration can reach alpd from [Paseo](https://paseo.sh)'s own app on another device, through Paseo's relay (`relay.paseo.sh`):

```sh
npm install -g @anhlp/alp-paseo@beta
alp-paseo-integration --register  # register in the selected ALP_HOME (also discoverable on PATH)
alp web pair --on     # turns the relay on and prints the pairing link
alp web pair          # the link again; --off turns the relay off
```

Open the link on the device that runs Paseo's app. Traffic between the device and alpd is end-to-end encrypted; the relay only passes it on. The link carries alpd's public key, not its token: when Paseo's app asks for a password, give it the password `alp web pair` prints (the token in `~/.alp/paseo.json`). The relay stays off until you turn it on; `"web": { "relay": { "endpoint": "host:port" } }` points the integration at another relay. Paseo's app shows ALP's sessions and teams, and answers what ALP has not built yet as an error. `alp-web-integration` remains an alias of `alp-paseo-integration`, and `ALP_WEB_INTEGRATION` of `ALP_PASEO_INTEGRATION`, for one release; a home registered with the old name (`integrations/web.json`) still starts the integration, with a hint to re-register. Details: [ALPD §64](plans/reference/ALPD.md#64-paseos-relay-and-its-app-on-another-device-2026-10-12).

## Antigravity CLI (experimental)

The Antigravity and ACP providers (OpenCode, Gemini CLI) are experimental in the beta. With `agy` installed and signed in:

```sh
alp provider test antigravity
alp run --model antigravity:gemini-3.8-flash-high --mode full-access "Describe this project"
```

A main profile can select `antigravity:gemini-3.8-flash-high` too. By default this adapter supports full access only. To run oracle, reviewer and supervisor on Antigravity, explicitly enable instruction-based read-only behavior:

```sh
alp provider edit antigravity --read-only-mode instructions
```

This stores `"readOnlyMode": "instructions"` in your library's provider configuration. ALP keeps advisory sessions read-only for its own tools and tells the agent to avoid changing files or external state, while the native agy process still runs with full access. This is a prompt constraint, not an OS sandbox or filesystem protection. It applies to new sessions; ALP does not downgrade an existing full-access AGY process to read-only. Use `--read-only-mode reject` to restore the default rejection. Workspace-write, review copies and custom permission rules remain unsupported.

MCP tools supplied by the project or editor are connected separately for each AGY session over stdio or streamable HTTP, then exposed through ALP's MCP bridge. The tool aliases and descriptions identify their original server. Commands, environment variables and HTTP authorization headers stay out of agy's global configuration. MCP resources and prompts are not forwarded through this tool bridge; configure a server directly in agy if you need those capabilities.

OpenCode (`opencode acp`) and Antigravity (`agy`) are added to your library by default, including on upgrades. Settings → Providers shows a switch at the end of each row to enable or disable them. Install and sign in to the corresponding CLI to use it; an absent CLI is shown as not installed. Existing commands, model settings and disabled switches are preserved across upgrades. OpenCode models use `acp:opencode/<model>`. To change a default command, use `alp provider edit opencode --command /path/to/opencode --arg acp` or `alp provider edit antigravity --command /path/to/agy`.

ALP installs one `alp` MCP launcher in `~/.gemini/config/mcp_config.json`, preserving other entries. Each agy process inherits its own socket and token; neither is saved in that file. The launcher remains available across sessions and exposes no ALP tools outside an ALP process. Invalid configuration and a conflicting user-owned `alp` entry cause an error without overwriting the file.

## Editors (ACP, experimental)

`alp acp` is experimental in the beta. It serves ALP over the [Agent Client Protocol](https://agentclientprotocol.com) on stdio, so an editor such as Zed or a JetBrains IDE can use ALP as its agent. In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "ALP": { "type": "custom", "command": "alp", "args": ["acp"], "env": {} }
  }
}
```

- Each editor thread is an ALP session in its project, worked by a team. Choose the team (Phở, Cafe, or your own) and the permission mode in the thread's options before the first prompt; the team is fixed after that.
- Main's replies, commands and tool calls stream into the thread, and so do the steps its team reports back after the prompt ended. Delegations show as tool calls.
- When an agent asks you something, the question appears in the thread: reply with `/answer <text>`, or `/dismiss`.
- Stop cancels main's turn and the work it started. Closing the editor leaves running work to finish in alpd; the thread's history lists ALP sessions of the project, and opening one shows its history.
- MCP servers the editor offers are given to the agents beside their own.

Details: [ALPD §60](plans/reference/ALPD.md#60-alp-as-an-acp-agent-2026-10-10).

## Paseo

To use the published plugin, follow [the plugin's README](integrations/paseo/README.md) or [beta-install.md](docs/alp/beta-install.md#paseo-plugin): `paseo plugin add npm:@anhlp/alp-paseo@beta` (from `0.0.0-beta.2`; in beta.1 the `npm:` source fails, [#111](https://github.com/phucanh08/alp/issues/111), so there run `npm install -g @anhlp/alp-paseo@beta`, then `paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"`). The plugin on `main` declares Paseo `>=0.11.1 <1.0.0`; the published `0.0.1-beta.3` declares `>=0.11.1 <0.13.0`, and `0.0.0-beta.2` and earlier `<0.12.0` (so Paseo 0.12 needs `0.0.1-beta.3` or later, and Paseo 0.13 needs a release after `0.0.1-beta.3`). See [installation and runtime behavior](docs/alp/paseo-plugin.md) and the historical [phase acceptance evidence](docs/alp/phase-2-5-results.md). The plugin was verified with Paseo 0.11.1 and live Codex and Claude Code permission changes before the beta; the beta's own runs are in [beta-scope.md](docs/alp/beta-scope.md) §6.

**Settings → ALP** manages your library of teams, agents, skills, MCP servers, hooks and ACP providers, and the **ALP project** workspace panel manages a project's overrides ([settings screen](docs/alp/paseo-plugin.md#alp-settings-and-the-project-panel)).

### Build and add the plugin to Paseo

This section builds the plugin from a checkout of this repository. Prerequisites: Node.js 22 (22.12 or later) or 24, Paseo 0.11.1 or later, up to 0.12.x (the Tasks panel needs the 0.11.1 plugin client API), and a logged-in Codex CLI and/or Claude Code installation. Set `ALP_CODEX_BIN` or `ALP_CLAUDE_BIN` to an absolute native executable path when it is not available on `PATH`.

Install dependencies, type-check the plugin, and build its server bundle:

```sh
npm ci
npm run check
npm run build:paseo
```

The build output is written to `integrations/paseo/server/dist/index.js`. Paseo plugins are trusted, unsandboxed code, so enable plugins only on a daemon where you trust this repository. In Paseo, open **Settings → Plugins** and turn on **Enable plugins**.

For a headless daemon, run `paseo daemon status --json` to find its `home`, set the root `pluginsEnabled` field in `<home>/config.json` to `true`, preserve the rest of the file, then apply the change:

```sh
paseo reload --json
```

Paseo requires an absolute path when adding a local plugin. From the repository root, run one of the following commands.

PowerShell:

```powershell
paseo plugin add (Resolve-Path .\integrations\paseo).Path
```

macOS/Linux:

```sh
paseo plugin add "$(pwd)/integrations/paseo"
```

Confirm that `alp-provider` is running and that the `alp` provider is available:

```sh
paseo plugin ls
paseo provider models alp
```

After changing the plugin source, rebuild and reload the installed plugin:

```sh
npm run check
npm run build:paseo
paseo plugin reload alp-provider
```

If loading fails, inspect the plugin process output with `paseo plugin logs alp-provider`. A full daemon restart is not required for source changes.

### Phở and Cafe

New projects default to Phở: main works directly or delegates to peer. Cafe
keeps main as supervisor while lead implements or delegates. In both, main runs on
Opus 5.5 with high effort and full access, and starts a supervisor on Sonnet 5
that reviews its process after each turn and asks main about mistakes; main records
lessons it follows in later sessions. Main can distill recurring lessons into a
skill for the roles it chooses, and open or comment on GitHub issues of the
project or of ALP; the user approves each skill and each post first. Both use read-only oracle/reviewer. Phở and Cafe
are ALP's built-in teams; you can make your own, with its own main, members,
delegation and house rules ([teams](docs/alp/agent-library.md#teams)). Select the
team in the Paseo model picker, with `alp run --team`, or in
`.alp/settings.json` → `workflow.mode`; `alp teams` lists them. The default concurrent peer limit is 2;
raise `workflow.maxPeers` only at the user's request. Writers in the shared checkout
run one at a time, across all sessions; writing peers can run in parallel in their own
git worktrees (`isolation: "worktree"`) and are merged with `alp_merge`. Oracle runs
on Fable (`claude:claude-fable-5-1`) or Astra (`codex:gpt-6-astra`); main may ask
both in parallel for two opinions. Runtime catalog and available plan/usage snapshots
inform coordination. See [team configuration and migration](docs/alp/team-workflow.md).

## Modular monorepo development

ALP is organized into npm workspaces for protocol, core, runtime, daemon, client, CLI, a reserved TUI, and the Paseo integration. See [package boundaries, build/test/release commands and the Rust migration seam](docs/modular-monorepo.md). Existing commands and checkout entry points remain compatible.

## License

ALP is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). Packages that bundle third-party code ship a `THIRD-PARTY-NOTICES.txt`. The `alp web` app's third-party licences are in `dist/alp-web/THIRD-PARTY-NOTICES.txt` of `@anhlp/alp-cli` (`packages/cli/dist/alp-web/` in `@anhlp/alp`). `@anhlp/alp-paseo` includes code taken from Paseo (Apache-2.0, © Mohamed Boudra) and ships Paseo's licence as `LICENSE.paseo.txt`; see that package's `NOTICE`. Its bundled third-party licences are in `server/dist/THIRD-PARTY-NOTICES.txt`.
