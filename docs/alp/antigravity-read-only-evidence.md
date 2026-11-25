# Antigravity read-only: what agy enforces (measured)

Two sets of measurements, each labelled with the agy version it was taken on: agy 1.5.2
(2026-11-06) and agy 1.5.15/1.5.16 (2026-11-24, see the version note there). They disagree about reads outside the workspace;
the newer one is what ALP documents. ALP does not keep agy's own reads inside the workspace:
it sends no read rule and no `allowNonWorkspaceAccess` setting (workstream t-ffa1 is open).

## agy 1.5.2 (2026-11-06)

Measured by hand on macOS arm64 with **agy 1.5.2**, driving agy exactly as
`antigravityModeArgs` does (`--input-format stream-json --output-format stream-json
--add-dir <cwd> --disable-slash-commands --sandbox --settings <json>`), on
2026-11-06 for t-c8ee and t-ffa1. Figures taken from agy's own
`step_update`/`result` events, not inferred. Anything not listed was not checked:
no Linux, no Windows, no other agy version.

### The floor a read-only session runs in (1.5.2)

| Action | Result |
| :-- | :-- |
| Write anywhere in the workspace (`node -e "fs.writeFileSync('x','y')"`) | `EPERM: operation not permitted`; the file is never created |
| Write in `os.tmpdir()`, `mkdtemp` | Succeeds |
| `cat` a file one directory above the workspace | `Operation not permitted` |
| `ls` the user's home | `Operation not permitted` |
| `cat /etc/passwd`, `cat ~/.gitconfig` | **Succeed** |
| `ls ~/.gemini/antigravity-cli/**` (agy's own state, incl. ALP's MCP tool definitions) | **Succeeds** |

The terminal sandbox is `/usr/bin/sandbox-exec` with a deny-default Seatbelt
profile. So the path boundary for a terminal command is that sandbox, not the
permission rule: a command allowlist cannot scope a path, and the sandbox leaves
system paths, the user's VCS config and agy's own state readable. That residual
is why the read-only terminal allowlist stays `pwd` only (ALP.md, t-c8ee), and
why a review that must run commands belongs on another provider.

### agy's own file tools (1.5.2)

The earlier premise was that `view_file`, `list_dir` and search still read
outside the workspace in read-only, and that the permission check happens only
after the read. On 1.5.2 that is **not** what happens:

- `read_file` **inside** the workspace runs.
- `read_file("~/.gitconfig")` is **refused**: `permission check failed for
  read_file ... user denied permission`, delivered as an `ERROR` step with no
  output, so the check precedes the read - there is no read-then-check gap.
- `list_dir` is advertised in the `init` event but calling it returns
  `Error: Tool 'list_dir' is not available in this environment`.

This refusal does not carry over: on 1.5.15, read-only `read_file` outside the workspace
**succeeds** (next section).

### Two provider behaviours ALP has to live with (1.5.2)

- **A denied tool ends the whole turn.** Headless agy cannot ask, so the first
  tool its mode does not allow ends the turn with an empty response and
  `denied_actions` set - which is how a read-only reviewer returned no handoff at
  all (issue #308). An agent instruction that names a command the allowlist does
  not carry therefore costs the whole assignment.
- **An accepted edit is reported as `edit_file`.** That is the tool name a real
  workspace-write session emitted on 1.5.2, while `init` announces `write_to_file`,
  `replace_file_content` and others. ALP's read-only table (`EDIT_TOOLS`) refuses it by
  name along with the other edit tools, so a denied edit that agy marks DONE is reported
  as failed, never as a completed change.

### Checking a settings key without spending a turn (1.5.2)

`agy --settings '{"someKey": ...}'` is validated before any model call and exits
with `--settings: unknown setting "someKey"` or an invalid-value error, so the
accepted schema can be probed at no cost. Accepted keys ALP uses:
`toolPermission`, `enableTerminalSandbox`, `trustedWorkspaces`, `permissions`
(`allow`/`deny`/`ask`) and `allowNonWorkspaceAccess` (a boolean). Rule *strings*
inside `permissions.allow` are **not** validated: a malformed rule is accepted
and grants nothing.

## agy 1.5.15/1.5.16 (2026-11-24)

Version note: `agy --version` read 1.5.15 at about 10:59 (+07:00); agy's updater replaced the
binary at 11:07, before the runs below (13:01-13:13), and the version was not recorded at run
time. The same binary reports 1.5.16 later that day. "1.5.15" below means this pair of versions.

Measured for t-9ae1 on macOS arm64 with **agy 1.5.15 or 1.5.16** and one model,
`gemini-3.8-flash-high`, driving agy as `AntigravityTransport` does. Each row is one prompt
asking agy to call its own `read_file` once on one absolute path; the result is read from
agy's `step_update` and `result` events. Two sets of flags were compared:

- **main**: `antigravityModeArgs` of origin/main (what this repository ships; no read rule).
- **pinned**: an earlier draft of t-9ae1 that added `allowNonWorkspaceAccess: false` and a
  `read_file(<root>)` allow rule per workspace root. That draft was **not** merged, because
  of the table below.

| Run | Mode | Flags | `/tmp` marker outside the workspace | `/etc/hosts` | `<ALP_HOME>/skills/bug-loop/SKILL.md` | `~/.gemini/GEMINI.md` (0 bytes) |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| M0 | read-only | main | read | read | read | — |
| M0 | read-only | pinned | read | read | read | — |
| M0 | workspace-write | main | refused, turn ended | refused, turn ended | refused, turn ended (step reported DONE) | — |
| M0 | workspace-write | pinned | refused, turn ended | refused, turn ended | refused, turn ended (step reported DONE) | — |
| M1 (new conversation) | read-only | pinned | read | — | — | read |
| M1 | read-only | main | — | — | — | read |
| R1 (`alp run`, main, Phở) | workspace-write | pinned | — | — | refused, turn ended, no handoff | — |

What this shows, on this version and model:

- In **read-only**, agy's own `read_file` reads outside the workspace: a file in `/tmp`,
  `/etc/hosts`, ALP's library under `<ALP_HOME>` and a file in agy's own `~/.gemini`. The
  1.5.2 refusal of `~/.gitconfig` above no longer describes agy.
- In **workspace-write**, the same reads are refused. A refusal ends the whole turn with an
  empty answer and `denied_actions` set; ALP then reports
  `Antigravity denied ReadFile in workspace-write mode and ended the turn.` (R1). For the skill
  file, with both sets of flags, agy reported the refused step as `DONE` with no output,
  so only `denied_actions` showed the refusal (t-a648). Library skills are outside the workspace, so a
  workspace-write role that opens its own skill loses its turn (t-4b59).
- The pinned flags changed **nothing measurable**: every row has the same result with both
  sets of flags. Whether 1.5.15 reads a `read_file(<path>)` rule at all is unknown.
- Tool names: `init` announces `view_file`, but the steps report `read_file`. No run
  edited a file, so the name 1.5.15 **reports** for an edit was not observed; `edit_file`
  stays in ALP's table on the strength of the 1.5.2 observation.

Limits: one model (`gemini-3.8-flash-high`), macOS only, one agy binary (version note above). The only
path under the user's home that was read is the empty `~/.gemini/GEMINI.md`, inside agy's own
directory; the rest of the home directory was not measured. M0 reused one conversation across
its four launches; M1 started a new one. Raw frames and tables: t-9ae1 task notes (M0, M1,
R1), evidence kept with the run under `/tmp/t-9ae1-peerA/evidence` on the measuring machine.

## Role runs on agy 1.5.16 (2026-11-24)

Each read-only role was given one normal assignment on Antigravity: one `alp_delegate` from a
scripted requester, in a scratch Git repository under `/tmp`, with model
`gemini-3.8-flash-high` on macOS. agy reported 1.5.16. The supervisor is started by ALP after
a scripted main turn instead of by `alp_delegate`.

| Role (read-only) | Assignment | ALP assignment id | agy conversation id | Result |
| :-- | :-- | :-- | :-- | :-- |
| reviewer | review a one-file diff | `alp-child-b2ce0490-68ac-4b89-86e5-b812c784d2c7` | `301ffc8b-70e5-4822-98be-2e1f795d4de8` | handoff with a verdict and path:line findings |
| oracle | advise on a design question | `alp-child-0b63b749-0bd9-4fb8-b6c4-06580452484e` | `a80efea4-7e77-44f5-87b6-089939bea470` | handoff with a recommendation and its evidence |
| peer | research the callers of a function | `alp-child-54dcd362-dc88-40c8-b592-61503cbc8324` | `651ae578-82d7-46a5-a045-50470a360b0f` | handoff with a path:line list |
| scout | locate code | `alp-child-bf3361eb-b41f-474f-abe1-1e8b8e87809d` | `71ba29a0-a7b0-4ce8-b232-4ca24e9357a6` | handoff with a path:line list |
| architect | draft an ADR | `alp-child-34f341e3-0d02-4eed-8f6d-f85ba09300ac` | `698b5a63-a6da-4580-b3c7-d4cd4caf9b66` | handoff with an ADR draft |
| lead (Cafe) | plan a fix as a peer brief | `alp-child-5f753d26-5458-41b0-b10d-bd5c300ad12b` | `bdb5c361-d274-4486-8130-26a42ca8dd0b` | handoff with a plan and a peer brief; it did not delegate |
| supervisor | review a main turn's digest | `alp-supervisor-83a9b835-7c31-4b19-bddc-8105827fb78c` | `858695f8-a116-4695-a963-65e69e8bc9cf` | a note to main naming three process faults of that turn. It ran with a team override `thinking: none` because of t-ca83; the shipped team still fails silently, and t-ca83 is open |

What the roles read and ran outside their task:

- Reads outside the workspace succeeded in read-only, as in the 1.5.15 table: architect, lead
  and peer opened their library skills under `<ALP_HOME>/skills/`, and the supervisor tried
  `<ALP_HOME>/lessons.md`, which did not exist. Every role also read agy's own MCP tool-schema
  files under `~/.gemini/antigravity-cli/mcp/alp/` before it called an ALP tool. agy recreates
  those files from the session's ALP tool list each time a session starts. Scout also read
  agy's built-in `run-workflow` skill and its own conversation transcript under
  `~/.gemini/antigravity-cli/`.
- Peer and scout ran `pwd`, the one command on the allowlist. No other command ran.
- No role tried to edit. So these runs still do not show which name 1.5.16 reports for an edit.

## A denied tool inside an assignment, agy 1.5.16 (2026-11-24, t-a648)

One peer assignment in **workspace-write** was told to `read_file` a file in `/tmp` outside
its workspace. agy refused it ("user denied permission for read_file(...)"). The next step,
a `read_file` of a workspace file that did not exist, was reported done with no output, and
then the turn ended. Nothing was edited and no handoff was filed. The requester's
`alp_delegate` returned status `completed`, `handoff: null` and the output
`Antigravity denied ReadFile in workspace-write mode and ended the turn.`: the requester learns
the tool name and the mode, not the path or the reason.

What ALP reports since t-a648, from these frames: agy's `denied_actions` gives only
`{action, display_name}`, so ALP takes the path from the input (`Path`) of the step that
agy refused, and the reason from that step's error text. agy gives an error only when it
reports the step `ERROR` (the M0 and T1 refusals: `permission check failed for read_file
"…": user denied permission …`). For a refused read that agy reports `DONE` with no output
(the M0 skill-file read), ALP takes the last such read **outside the workspace**. From what
agy reports, that read cannot be told apart from a missing file outside the workspace, so
the reason reads `agy gave no reason; inferred: …`, and ALP records the step as failed. A
`DONE` read with no output inside the workspace (the T1 missing file) is never taken for
the denial. The assignment fails because agy listed a denied action and the turn ended
with no answer and no handoff. It never fails on ALP's inference alone: with no
`denied_actions`, a `DONE` read with no output stays completed. This changes no flag, no
allowlist and no read containment (t-ffa1, t-c8ee); it is reporting only.
`test/integration/antigravity-denied-turn.test.js` replays the M0 frames in both variants,
and the T1 sequence, and asserts this result. Not yet checked on a real agy (chưa kiểm bằng
agy thật).

## agy over ACP, and the t-a648 check, agy 1.5.16 (2026-11-25, t-bc8b.1)

Seven real agy conversations, approved by the user (six over `agy acp --disable-telemetry`,
one headless through ALP). A scratch driver spoke ACP over stdio and logged every frame; the
agy process alone ran with the user's home, everything else in a scratch directory. agy was
1.5.16 before and after. In conversation 2, agy's default model, gemini-4-hydrogen, did one step, and
then every answer was a quota message: the account's quota for the Gemini models was
exhausted, so conversations 3–7 ran on agy's `claude-sonnet-4-6` (the user's decision).
Every permission request seen came from agy while Sonnet 4.6 was selected; none was seen on a
Gemini model. The model chooses which tool to call, so behaviour measured on Sonnet 4.6 may
differ on a Gemini model.

| # | What | Model | Observed |
|---|---|---|---|
| 1 | M0: flags, initialize, session/new, config | gemini-4-hydrogen | see "What agy offers over ACP" |
| 2 | A, Default, allow every request | gemini-4-hydrogen | one in-workspace `read_file`, no request; then every answer was the quota message, `stopReason: end_turn`, no error |
| 3 | A again | claude-sonnet-4-6 | requests for the outside read, the scratch SKILL.md read, `pwd`, `git status`, the in-workspace edit; none for the in-workspace read; MCP not reachable (below) |
| 4 | B, reject every request | claude-sonnet-4-6 | each reject ends the turn (below) |
| 5 | D, mode `accept-edits` | claude-sonnet-4-6 | still asks for the outside read and every command; `touch` outside the workspace succeeded; cancel works (below) |
| 6 | T, headless through ALP (t-a648) | claude-sonnet-4-6 | assignment `failed` with `denied[]` (below) |
| 7 | Resume of conversation 3 | claude-sonnet-4-6 | `session/load` in a new process replayed 31 updates; the next answer used the earlier context |

### What agy offers over ACP (conversation 1)

- `agy acp --help` lists `--sandbox` ("Run in a sandbox with terminal restrictions
  enabled"), `--dangerously-skip-permissions`, `--add-dir`, `--process-per-session` and
  `--login`. There is no `--mode`, `--model` or `--settings` flag on `acp`. The runs below
  were made **without** `--sandbox`; what it confines over ACP is not measured.
- `initialize`: `loadSession: true`; `sessionCapabilities` resume, close, load, list,
  additionalDirectories; prompts take images and embedded context.
- `session/new` offers four modes: `default` ("Ask before edits and commands"),
  `accept-edits` ("Approve file edits in the workspace without asking"), `auto` ("Approve
  edits and safe commands; ask before irreversible actions") and `plan`. They are also the
  config option `mode`.
- Config option `model` takes base ids (`gemini-4-hydrogen`, `gemini-3.8-flash`,
  `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`). Config option
  `thought_level` takes `low`, `medium`, `high`, `xhigh` and is separate from the model. It
  disappears from the options while `claude-sonnet-4-6` is selected.
- `availableModels` lists suffixed ids (`gemini-4-hydrogen-high`, `…-xhigh`, …).
  `set_config_option model = "gemini-4-hydrogen-high"` was accepted and gave
  `model = gemini-4-hydrogen` with `thought_level = high`. `session/set_model` accepted
  both the base id and the suffixed id.
- Every changed value was set back before the process ended.

### Permission requests (conversations 3–5)

- **Every** request offered exactly two options: `allow_once` ("Allow") and `reject_once`
  ("Deny"). There was no `allow_always`.
- Tool names on the wire: `read_file` (kind `read`, `rawInput {Path}`), `write_file` (kind
  `edit`, `rawInput {Append, Content, Path}`) and `run_command` (kind `execute`,
  `rawInput {CommandLine, WaitMsBeforeAsync, toolSummary}`). Read and edit requests carry
  `locations` with the absolute path; command requests carry none.
- Default mode: a read inside the workspace raised no request. agy **asked** before a read
  outside the workspace, before `pwd`, before `git status` and before an edit inside the
  workspace.
- Accept-edits mode: agy still asked before the outside read and before each command (`touch`,
  `sleep 20`, `sleep 30`). No edit was tried in this mode.
- `session/new` with `mcpServers` naming a stdio server `alp` did **not** start that server:
  the start log that the dummy server writes when it starts was never created. The model then read `~/.gemini/antigravity-cli/mcp/alp/alp_board.json`
  without a request; the file did not exist and the step failed. Over ACP in 1.5.16, an MCP
  server passed by the client is not available to the model, as far as this run shows.
- A rejected request: the tool update turns `failed` with `rawOutput` `permission check
  failed for read_file "<path>": user denied permission for read_file(<path>)` followed by
  `Do not attempt to circumvent this denial …`. The prompt returned 2–4 ms later with
  `stopReason: end_turn`, no text and no further tool call. Same for a rejected
  `write_file`. **A reject ends the turn**, and agy gives the path and the reason.
- With no `--sandbox`, an allowed `touch` of a file outside the workspace (in the scratch
  directory) succeeded. No other confinement of commands was tested.
- `sleep 20 && echo done`: the request carried `WaitMsBeforeAsync: 25000`. The model also
  used a `manage_task` status tool (kind `other`, no request). The prompt returned after
  the command had ended. No update came after a prompt returned in any conversation.
- `session/cancel` during `sleep 30`: the tool update turned `failed`, and the prompt
  returned `stopReason: cancelled`. No `sleep 30` process was left 2 s later, and no update
  came in the next 30 s.
- Quota (conversation 2, gemini-4-hydrogen): the driver saw the quota message as an
  ordinary agent message with `stopReason: end_turn` and no error. It was not run through
  ALP. The inference, not measured, is that an ALP assignment over ACP would read such a
  turn as an answer.

### t-a648 on a real agy (conversation 6)

A peer in workspace-write on `antigravity:claude-sonnet-4-6` (ALP at main 8f2707c0, which
contains cb198f3e) was told to `read_file` a scratch file outside its workspace. The
real run's argv was not captured. With the same configuration, a dry run against a fake agy
got `--mode accept-edits --sandbox`, the usual `--settings` and `--model claude-sonnet-4-6`,
and no `--effort`. agy refused the read and reported the step as
an ERROR, with the error text above. The turn ended. The requester got:

```
status: failed, handoff: null
error: peer's turn ended because ReadFile on <path> was denied (permission check failed for
       read_file "<path>": user denied permission for read_file(<path>)) in workspace-write
       mode; no handoff was filed.
denied: [{tool: "ReadFile", path: "<path>", reason: "permission check failed for read_file …"}]
```

Both the path and the reason come from agy's error step; neither is inferred. agy wrote
`~/.gemini/antigravity-cli/mcp/alp/alp_*.json` for this session. Whether the model could
call those tools was not observed. The
child's own `turn.ended` still says `completed`.

### Not measured

- Gemini models beyond the first step of conversation 2 (quota).
- `agy acp --sandbox` in a conversation.
- The `auto` and `plan` modes, and an edit in `accept-edits`.
- Permission requests for MCP tools over ACP (the server passed in `session/new` never
  started).
- On a real agy, the `DONE` with no output shape of a denial (t-a648 inference path): T
  produced the `ERROR` shape only.
- `--dangerously-skip-permissions`, `--process-per-session` and `--add-dir`.

### What agy wrote in the user's home

agy wrote under `~/.gemini/antigravity-cli/`, and only kinds that earlier runs had made:
a conversation database and a `brain/` directory for each conversation, `annotations/`, an
`acp-server-*.log` for each ACP process, one `cli-*.log` (T), `presence/<id>.lock` (T), the
`mcp/alp/*.json` files (T), and the shared `cache/onboarding.json`, `implicit/*.pb` and
summary files. `~/.gemini/config/mcp_config.json` kept the same sha256. The mtime of
`~/.local/bin` changed at the T start, but its entries stayed the same. Other agy
processes ran on the machine at the same time. Their writes are left out here.
