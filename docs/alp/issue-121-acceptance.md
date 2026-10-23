# Issue #121: acceptance of the five checkboxes

Task t-15b0.18 (issue #121, branch L, closure audit). This document maps each checkbox of
[#121](https://github.com/phucanh08/alp/issues/121) to the code that ships it, the contract, the
gateway permission, the client surfaces and the evidence. It changes no product code. The tests this
branch adds are listed in §3.

**Closure scope.** On 2026-10-22 the user decided that #121 closes when Codex and Claude work fully on
macOS and Linux. Windows (worktrees, terminal PTY) and ACP/Antigravity are documented as unsupported and
do not block closing (project board decision p-640896b4). On 2026-10-23 the user accepted that the Paseo
web facade cannot upload attachments yet (t-4f38); this is a known limit of checkbox 5.

**Status values.**
- **done**: shipped on Codex and Claude (macOS/Linux) on every surface the row names, with the evidence cited.
- **done, with limit**: shipped, but one surface or case is missing. The limit is named and listed in §5.
- **not done**: no row has this status. If one did, #121 would not close.

**Surfaces.**
- *web*: `apps/web`, the browser app. It reaches alpd only through the remote gateway, with a scoped credential.
- *facade*: the `alp web` Paseo facade, `integrations/paseo/server/paseo/`. This is Paseo's own UI on ALP;
  a paired device has owner-level rights.
- *provider*: the Paseo provider plugin inside a user's own Paseo daemon. It keeps its prototype limits
  ([paseo-plugin.md](paseo-plugin.md#prototype-limits)) and is not a surface of #121.

**Credentials.**
- *scoped*: a gateway credential with explicit permissions. The web e2e worlds
  (`apps/web/e2e/support/world.js`) and the gateway suites (`apps/gateway/tests/*`,
  `test/integration/gateway.test.js`) cover these.
- *owner*: a local IPC client or the facade. The real-runtime scripts (`test/e2e/*-real-e2e.mjs`), the
  daemon suites and the facade suites cover these.

## 1. Matrix

### Checkbox 1: fork / rewind a session, and page history backwards

| Sub-feature | PRs | Contract | Gateway permission | web | facade | Evidence | Status |
|---|---|---|---|---|---|---|---|
| Page history backwards | #181 | §8.7 `session.history` (capability `session.history`) | `session.read`; the gateway authorizes before it reads a cursor and sets its own byte budgets | "Load older messages" with a stable anchor (W:Timeline) | `fetch_agent_timeline_request` with `direction: 'before'` reads alpd's older page (agents.ts `olderTimeline`); the same for subagents | `apps/web/e2e/history.spec.js` (650 items, anchor, append, reconnect); `packages/daemon/tests/history.test.js`; `apps/gateway/tests/authorization.test.js` "history authorizes before cursor forwarding…"; `integrations/paseo/tests/agents.test.js` "durable backward pages…" | **done** |
| Fork a conversation (through or before a turn, new tab or new worktree, restore a set-aside branch) | #189, #197 | §12.7 `session.fork` | `session.write` + `session.read`; the source, destination and created root must be in the grant | "Fork from here…" (W:Conversation ForkAction/ForkDialog) | not offered: Paseo's fork is a text summary sent as a new agent's first message, so the facade keeps `agentForkContext` off (`server/paseo/index.ts:36`) | real Codex and Claude: `test/e2e/conversation-real-e2e.mjs`, log in [issue-121-native-evidence.md](issue-121-native-evidence.md) part 2, rerun here (§4); `apps/web/e2e/conversation.spec.js`; `apps/gateway/tests/conversation.test.js`; `packages/daemon/tests/conversation{,-crash}.test.js` | **done, with limit** (L1, L2) |
| Rewind (conversation only, same ALP id, discarded branch recoverable, files unchanged) | #189, #197, #198, #199, #200 | §12.7 `session.rewind`, `history.reset` | `session.write`, within the grant's modes | "Rewind to here…", a rewind marker that restores its branch | Paseo's rewind in conversation mode becomes `session.rewind`; files/both are refused | as for fork; also `integrations/paseo/tests/{rewind,attach-reset,reattach}.test.js` | **done, with limit** (L2) |

### Checkbox 2: change team or model on a live session

| Sub-feature | PRs | Contract | Gateway permission | web | facade | Evidence | Status |
|---|---|---|---|---|---|---|---|
| Model and effort change on the same conversation | #192, #198 | §12.9 `session.configure { model, thinking }`, `session.configure.preview` (capability `session.configure.live`) | `session.write` within the grant's modes; preview `session.read` | composer Model and Thinking menus (W:SessionView LiveAgentControls) | `set_agent_model_request` (a runtime-prefixed model), `set_agent_thinking_request` | real Codex and Claude: `test/e2e/configure-real-e2e.mjs` (Codex rollout `turn_context` and Claude's init and transcript show the new model, also after close/reopen and an alpd restart), rerun here (§4); `apps/web/e2e/configure.spec.js`; `apps/gateway/tests/configure.test.js`; `packages/{runtime,daemon}/tests/configure.test.js`; `integrations/paseo/tests/configure.test.js` | **done, with limit** (L3) |
| Team change; future delegations follow the new team; earlier assignments keep theirs | #192 | §12.9 `session.configure { team }` | `session.write` + the opt-in `session.team.write` | composer Team menu; without `session.team.write` the menu says so | `set_agent_model_request` with a team id | as above; this branch adds the delegation tests (§3) | **done, with limit** (L3) |

### Checkbox 3: Git, Changes/Diff, terminal, Copy resume command, Reload agent

| Sub-feature | PRs | Contract | Gateway permission | web | facade | Evidence | Status |
|---|---|---|---|---|---|---|---|
| Git status and Changes/Diff, read only | #186 | §12.5 `workspace.git.status`, `workspace.git.diff` (capability `workspace.git`) | status `project.read`; diff `project.read` + `files.read` | Changes and Diff panels (W:GitPanels) | `checkout.ts` asks alpd and translates; no local Git | `apps/web/e2e/changes.spec.js` (real alpd and gateway, three tokens); `packages/daemon/tests/git.test.js` (external diff, textconv, fsmonitor, PATH traps; secret renames); `apps/gateway/tests/git.test.js`; `integrations/paseo/tests/checkout-git.test.js` | **done, with limit** (L4) |
| Terminal (real PTY on the daemon host) | #194, #195 | §12.10 `terminal.*` (capability `terminal`) | `terminal.exec` (never a default), plus the host owner's `alp terminal allow --yes` | Terminal tab (W:TerminalPanel, xterm.js) | Paseo's terminal pane, after a second opt-in `alp terminal allow --paseo --yes` | `apps/web/e2e/terminal.spec.js` (real shell: prompt, Ctrl-C, resize, reload, reconnect, exit; refusal without `terminal.exec`); `packages/daemon/tests/terminals.test.js` (revocation, process cleanup); `apps/gateway/tests/terminal.test.js`; `integrations/paseo/tests/terminals.test.js`; packed-tarball installs in PR #194 | **done, with limit** (L5, L6) |
| Copy resume command | #191 | §12.8 `session.resumeCommand` (the host builds `alp attach <id>`) | `session.read`; the gateway rebuilds the command from the id | tab menu "Copy resume command", clipboard only | not offered: Paseo builds this item from a native provider template, and ALP must not hand out `codex resume` or `claude --resume`, which would continue outside ALP | `apps/web/e2e/reload.spec.js`; `apps/gateway/tests/reload.test.js`; quoting tests in PR #191; `test/e2e/reload-real-e2e.mjs` checks the answer | **done, with limit** (L7) |
| Reload agent | #191 | §12.8 `session.reload` | `session.write`, within the grant's modes | tab menu "Reload agent" | `refresh_agent_request` becomes `session.reload` | real Codex and Claude: `test/e2e/reload-real-e2e.mjs` (same thread and configuration; the next reply remembers the earlier turn), rerun here (§4); `apps/web/e2e/reload.spec.js`; `integrations/paseo/tests/reload.test.js` | **done** |

### Checkbox 4: workspace/project registry (worktree and branch rows, pins, add-project)

| Sub-feature | PRs | Contract | Gateway permission | web | facade | Evidence | Status |
|---|---|---|---|---|---|---|---|
| Shared registry: project and workspace rows with branch | #182, #201 | §16 `project.list`, `workspace.list/get` (capability `workspace.registry`) | `project.read`; filtered by the grant before paging and counts | sidebar rows under each granted project, with branch (W:Sidebar) | `fetch_workspaces_request` from alpd's registry (`server/paseo/workspaces.ts`) | `apps/web/e2e/registry.spec.js`; `packages/daemon/tests/{registry,registry-rpc}.test.js`; `apps/gateway/tests/registry.test.js`; `integrations/paseo/tests/paseo-web.test.js` "projects and workspaces are kept by alpd…" | **done** |
| Pins shared across clients and kept across restarts | #182 | §16 `workspace.update { pinned }` | `workspace.write` | Pin/Unpin on each row; pinned rows first | `workspace.pin.set.request` | `apps/web/e2e/registry.spec.js` (two browsers, then an alpd restart; a default token is told it needs `workspace.write`) | **done** |
| Add project | #182 | §16 `project.register` | `workspace.write`; only an existing, exactly pregranted canonical directory | sidebar "Add project" with the token's granted directories | `open_project_request` (owner) | `apps/web/e2e/registry.spec.js`; the second spec there checks that outside grants are denied without registry or credential writes | **done, with limit** (L8) |
| Worktrees: create, remove, branch row | #183, #184, #201 | §16 `workspace.worktree.options/create/remove` (capability `workspace.worktree`) | `workspace.manage` + the mapping id in the grant; the new checkout is granted to its creator only | WorktreeActions on a row | create only: `workspace.create.request` with a worktree source becomes `workspace.worktree.create` (only when exactly one mapping is approved); archiving the workspace keeps the checkout |  `apps/web/e2e/worktrees.spec.js` (create, branch after a restart, remove; refusals for a missing mapping, a dirty checkout, an active session, a saved session); `packages/daemon/tests/worktrees.test.js`; `packages/core/tests/user-worktree.test.js`; `apps/gateway/tests/worktrees.test.js`; `packages/daemon/tests/backup-authority.test.js`; `integrations/paseo/tests/paseo-web.test.js` (the owner bridge creates only generated worktrees); [apps/gateway/docs/worktree-evidence.md](../../apps/gateway/docs/worktree-evidence.md) | **done, with limit** (L9) |

### Checkbox 5: non-image file attachments

| Sub-feature | PRs | Contract | Gateway permission | web | facade | Evidence | Status |
|---|---|---|---|---|---|---|---|
| Attachment store (chunked upload, opaque ids, quotas, retention, fork pins) | #188 | §12.6 `attachment.*` (capability `attachments`) | `attachments.write` + `session.write` (`get`: + `session.read`) | composer upload with progress and retry | **refused** (`file.upload.request` answers an error; a message with attachments is refused, never dropped) | `packages/daemon/tests/attachments{,-crash}.test.js`; `apps/gateway/tests/attachments.test.js`; `integrations/paseo/tests/facade-attachments.test.js` | **done, with limit** (L10) |
| Codex and Claude read the bytes (`file.path` staging) | #193 | §12.6; `promptAttachments` in the session snapshot | as above | drop, pick and paste of any file (W:Composer) | the provider's `uploaded_file` path is translated (`server/uploads.ts`); the facade is not | real Codex and Claude: `test/e2e/attachments-real-e2e.mjs` (SHA-512 and bytes at a random offset that only reading gives; retry after a restart; fork), rerun here (§4); `apps/web/e2e/attachment-files-real.spec.js` (browser → gateway → alpd → real runtimes; opt-in, PR #193); `apps/web/e2e/attachment-files.spec.js`; `packages/daemon/tests/attachments-runtime.test.js`; `integrations/paseo/tests/uploads-alpd.test.js` | **done, with limit** (L10, L11) |

## 2. Security evidence by credential

| Area | Scoped credential (gateway) | Owner (local) |
|---|---|---|
| History | permission and scope before any cursor is read; untrusted byte budgets replaced (`apps/gateway/tests/authorization.test.js`) | `packages/daemon/tests/history.test.js` (tampered and stale cursors) |
| Fork/rewind | the source, a child, the destination and the new id outside the grant are refused before alpd; principal context and requestId are set by the gateway (`apps/gateway/tests/conversation.test.js`) | crash points and unknown outcomes (`packages/daemon/tests/conversation-crash.test.js`) |
| Configure | `session.team.write` is opt-in and implies nothing; a child, scope and modes are refused before alpd (`apps/gateway/tests/configure.test.js`) | escalation (mode, hooks, commands) refused (`packages/runtime/tests/configure.test.js`) |
| Git | without project.read nothing reaches Git; project.read without files.read gets no content (`apps/gateway/tests/git.test.js`, `apps/web/e2e/changes.spec.js`) | no program the repository or environment names runs (planted git, drivers, filters, fsmonitor, pager, hooks); secrets on either side of a rename are withheld (`packages/daemon/tests/git.test.js`, `integrations/paseo/tests/checkout-git.test.js`) |
| Terminal | without `terminal.exec` nothing reaches alpd; a revoked, rotated or regranted credential's terminals end (`apps/gateway/tests/terminal.test.js`, `apps/web/e2e/terminal.spec.js`) | the host switch and the Paseo switch (`packages/daemon/tests/terminals.test.js`, `integrations/paseo/tests/terminals.test.js`) |
| Registry/worktrees | filter before page/count; outside grants denied with no writes; derived grants only for the creator (`apps/web/e2e/registry.spec.js`, `apps/gateway/tests/{registry,worktrees}.test.js`) | journal crash/retry, backup quarantine (`packages/daemon/tests/{worktrees,backup-authority}.test.js`) |
| Attachments | a session outside the grant answers as a missing one; a credential revoked mid-upload loses its connection; no host path leaves the gateway (`apps/gateway/tests/attachments.test.js`) | ids of another principal, epoch, project or session answer exactly as unknown ones; link and hard-link swaps refused (`packages/daemon/tests/attachments.test.js`); link, FIFO and changed-copy tampering, staged copies read-only and never executable (`packages/daemon/tests/attachments-runtime.test.js`) |

## 3. Tests this branch adds

The t-15b0.16 review found no test showing that a delegation after a team change follows the new team,
or that an earlier assignment keeps its own. This branch adds both:

- `packages/runtime/tests/configure.test.js`: "after a team change, the next delegation follows the
  new team; an earlier assignment keeps its own". On Phở, main delegates to `peer`, and the peer's
  instructions say Phở. After `reconfigure({ team: 'cafe' })`, the same root's delegation to `peer` is
  refused. Its delegation to `lead` starts with Cafe's instructions (`assign bounded work to: peer,
  oracle, reviewer`), and the snapshot says `cafe`. The earlier assignment was not restarted.
- `packages/daemon/tests/configure.test.js`: "configure: after a team change the next assignment runs
  on the new team; an earlier assignment's record keeps its own". The same flow goes through alpd's
  `session.configure`. `session.get` of the earlier assignment says `pho` and the later one `cafe`,
  also after an alpd restart, read from the store.
- RED/GREEN: both fail when the built runtime does not take the new team's delegation graph (removing
  `live.graph = plan.shape.graph` in `reconfigureSession`), and pass with it.

## 4. Fresh verification

All runs used an isolated `ALP_HOME`, on macOS (Darwin 27.0.0, arm64) with Node v26.3.0, in a new
worktree of `origin/main` **3d003c4** (the last #121 product commit, PR #201). This branch changes only
docs and tests, so the product code is the same as the PR head's.

**Gates on 3d003c4 (2026-10-23 13:03–13:12 UTC)**

| Command | Result |
|---|---|
| `npm run check:boundaries` | pass |
| `npm run check` | pass |
| `npm run validate:core` | pass: 873 tests, 869 pass, 0 fail, 4 skipped (Windows-only) |
| `npm run validate:paseo` | pass: Paseo 228/228; integration 231, 230 pass, 0 fail, 1 skipped |
| `npm run validate:web` | pass: unit 278/278; Playwright 62 passed, 2 skipped (`attachment-files-real.spec.js`, opt-in real runtimes) |

The head of the PR that adds this document runs the same gates locally and in CI (`.github/workflows/ci.yml`). Its results are in that PR. A document cannot name the commit that contains it.

**Real runtimes (owner, local IPC; 2026-10-23 13:13–13:18 UTC; `node test/e2e/<name>-real-e2e.mjs codex claude`)**

Installed `codex-cli` and Claude Code, on the scripts' default small models (`codex:gpt-6-luna`,
`claude:claude-haiku-4-5`; configure changes Codex to `gpt-6.1-sol` and Claude to `claude-sonnet-4-6`).
Before each run, Codex had used 0–1% of its five-hour window and 1% of its weekly window.

| Script | Codex | Claude | What the log shows |
|---|---|---|---|
| `conversation-real-e2e.mjs` | pass | pass | The fork through T1 answers ALPHA only; the source answers ALPHA and BRAVO; a rewind answers ALPHA on the same session; a repeat after an alpd restart is `duplicate`; the restored branch answers ALPHA and BRAVO; the project file's SHA-256 is unchanged. |
| `configure-real-e2e.mjs` | pass | pass | Configure is refused while busy and for another runtime. The model, effort and team (Cafe) change on the same thread; the next reply recalls ALPHA; the runtime's own records name the new model after configure, after close/reopen and after an alpd restart. |
| `reload-real-e2e.mjs` | pass | **fail, then pass** | First Claude run: turn 1 ignored "Remember codeword ALPHA" before any reload; after the reload, Claude called the prompt a "hidden override instruction" and the step failed. Claude's reply blamed a "system reminder". ALP adds no system-reminder tag, but it does put its catalog data part in front of each prompt (`packages/runtime/src/runtime.ts:4109`). The same kind of refusal is recorded for the conversation script in the native evidence (the 2026-10-22 21:40 run). A separate rerun, `reload-real-e2e.mjs claude` at 13:17, passed: never-prompted refused `no_history`, `session.reloaded`, receipt `duplicate`, ALPHA after the reload, `alp attach <id>`. |
| `attachments-real-e2e.mjs` | pass | pass | Each runtime's own tools report the SHA-512 of a binary, a PDF and a text file, plus bytes at a random offset. A retry after an alpd restart is `duplicate` on the same staged copy. A fork reads the file again. |

Every native thread these runs made was deleted: 17 `cleanup` steps, all `deleted: true`. No alpd, app-server or
Claude process was left over. The browser real-runtime spec (`attachment-files-real.spec.js`) was not
rerun here; its pass is recorded in PR #193.

## 5. Limits accepted for closing

- **L1, fork in the facade.** Paseo's fork menu is not offered on ALP agents: Paseo's fork is a text
  summary, not a faithful fork. Fork is in apps/web.
- **L2, runtimes and boundaries.** Fork and rewind support Codex and Claude on macOS/Linux only. ACP and
  Antigravity answer `runtime_unsupported`; Windows does not list the capabilities. Codex legacy-history
  threads were not verified natively (an unverifiable fork is deleted and refused). Claude turns ALP did
  not start cannot be cut at (`boundary_unmapped`). Rewind never restores files. Details:
  [issue-121-native-evidence.md](issue-121-native-evidence.md#limits).
- **L3, configure.** A session keeps its runtime (another runtime's model is refused with
  `runtime_mismatch` and the action `session.create`); its agent; and its permissions. Only a root is
  reconfigured; assignments keep the team and model they started with. ACP and Antigravity answer
  `runtime_unsupported`.
- **L4, Git.** Read only: commit, push, pull, merge and branch switching are not in the protocol. A
  workspace that is a subdirectory of a repository is `unsupported`. The facade shows only alpd's first
  diff page. Not supported on Windows (no process-group kill).
- **L5, terminal on Windows.** Not supported.
- **L6, terminal parity (t-d71b).** One terminal per workspace. No font or theme settings, no link or
  search addons. The facade's `capture_terminal` answers not implemented. Browser keyboard behaviour
  was checked only on macOS Chrome. Smaller open lows are recorded in t-d71b.
- **L7, Copy resume command in the facade.** Not offered (see the matrix). apps/web offers the
  host-built `alp attach <id>`.
- **L8, add-project.** A remote token registers only an existing directory its grant already names.
  Browsing or creating host directories stays a proposal (§14 `host.directories.suggest`), so the
  owner widens the credential first. apps/web has no button for `project.remove`. Labels and placement
  are owner-only (`registry.owner`).
- **L9, worktrees.** Not supported on Windows: alpd does not list `workspace.worktree` there. On
  macOS/Linux:
  - a worktree is created only from the source's committed HEAD, under a generated name and branch
    (`alp/workspace/<id>`). Neither apps/web nor the facade offers a base ref, a branch name, setup hooks
    or a first agent; the facade refuses those (`server/paseo/workspaces.ts:359`);
  - only the principal and grant epoch that created a worktree can remove it (`not_managed`);
  - the facade cannot remove one. Archiving the workspace there archives the record and keeps the
    checkout on disk (`server/paseo/workspaces.ts:256-260`); removal is in apps/web;
  - the facade needs exactly one approved mapping for the source and refuses otherwise
    (`server/paseo/workspaces.ts:368`); apps/web lets the user choose.
- **L10, attachments in the facade (t-4f38).** The `alp web` Paseo facade refuses uploads. The user
  accepted this on 2026-10-23. apps/web and the provider's `uploaded_file` path work.
- **L11, attachment runtimes and platform.** Codex and Claude take `file.path`. ACP and Antigravity
  answer `1005 attachment_unsupported`. alpd keeps no attachment store on Windows. Masking of the staging
  path in text an agent writes is best effort.

## 6. Open follow-ups (not blocking closure)

| Task | What |
|---|---|
| t-82e0 | The scheduler delivers a job while a wake is starting its turn (it checks only `activeTurnId`). |
| t-1bad | `resumeRuntime` also continues roots that recovery parked for an explicit `alp resume` (pre-existing). |
| t-1e77 | A rewind marker's cursor is assigned at commit but broadcast after; an attach without `generation` in between can be out of step. |
| t-cd5f | Lifecycle journal: `unknown` entries are never settled and are re-read at each start for 7 days. |
| t-74b4 | Legacy mode-only `session.configure` and `session.create { resume, spec }` do not persist to the record (pre-existing). |
| t-95e1 | Runtime `closeSession` deletes by id without checking the record's identity. |
| t-92bf | `session.list` builds every summary before filtering `rootsOnly` (the facade polls every 2 s). |
| t-71b5 | `registry.resolve` accepts any realpath for a record without `canonical`, unlike `sourceOf`/`describe`. |
| t-0079 | The client drops hello's `attachmentLimits`/`terminalLimits`; no upload abort in the SDK; clearer `content_type` errors. |
| t-22d5 | Attachment store lows (epoch purge symmetry, close() during a sweep, owner IPC error text). |
| t-c5fd | Fork/rewind lows (stale comment, unused worktree after a lost answer, SDK docs, two-browser `history.reset` e2e). |
| t-17c6 | Git/Diff lows; the facade's files/workspaces still use the bridge's own `checkoutFacts`. |
| t-d71b | Terminal parity gaps (L6). |
| t-4f38 | Facade attachment upload (L10). |
