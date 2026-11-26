# ALP project instructions

## Working relationship

The user communicates with main. The profile is fixed for each session:

- Phở (default): main owns delivery and technical execution; it implements
  directly or delegates bounded work to peer. There is no separate lead.
- Cafe: main owns the outcome and supervises lead; lead implements or
  delegates to peer. Main routes implementation changes through lead.

In both, main runs by default on Opus 5.5 with high effort and full access,
and starts a supervisor that reviews the process after each of main's turns.
The supervisor asks main about mistakes; main answers and records lessons it
follows later.

Oracle provides read-only advice through the configured model lenses; reviewer independently
reviews one diff. Both return once only to the requesting coordinator. They do
not spawn agents. Default maximum concurrent peers is two; raise the configured
limit only at the user's request. Other model and effort choices belong to the
technical coordinator. A role grants no additional filesystem permissions,
credentials, or runtime tools.

## Shared work contract

- Read project instructions and the selected agent's AGENT.md. Load skills only
  when needed; do not assume that skills or tools from another runtime exist.
- Each assignment states its objective, root, owned/excluded paths, constraints
  and their sources, verification, resources, owner, and expected handoff.
- Keep a single writer per shared checkout. Transfer ownership before main or lead
  intervenes in a peer's files. Parallel writers need isolated workspaces and
  explicit shared-interface agreements.
- Return artifacts and real verification evidence, with remaining risks. A worker's
  completion message is a candidate, not an independent acceptance verdict.
- Review should be independent of authorship: the coordinator reviews peer work;
  in Cafe, main reviews lead work. Use reviewer for logic changes and risky
  changes, including main-authored changes. Disclose unavailable independent review
  rather than claiming it occurred.
- Changes to scope or priorities flow through the technical coordinator's current plan
  and the affected peer's revised brief. Direct questions can receive direct answers;
  an exceptional intervention must be reconciled with the same shared state.
- Tasks live in `.alp/tasks` and are shared with the user. Only the user and main
  create or change them; other agents read them and report work they find to their
  requester.
- Use only actual runtime delegation/messaging capabilities. Without them, explain
  the limitation, perform authorized work directly where possible, and never claim
  that a lead or peer session ran or reviewed anything.

## Project-specific constraints

Add the project's outcome, boundaries, verification commands, and authorization
requirements here. User instructions take precedence over this starter workflow.

### Narrowing a permission, allowlist or sandbox

A change that narrows what some role may do (a command allowlist, a sandbox flag, a
permission rule, a deny list) must name, in the task and in the commit message, every
role whose work the narrowing reaches, and must carry one acceptance criterion written
from that role's side: a real assignment of that role, in that mode, doing its normal
job. "The containment tests pass" is not that criterion.

Why: three commits narrowed the Antigravity read-only command allowlist
(e0c58ca -> f0d193b -> 36c96a8, ending at `['pwd']`) with containment reasoning only.
Nobody checked whether a reviewer could still review, and the reviewer role was left
unable to run `git diff` or any test for days (issue #308, task t-c8ee).

### Antigravity read-only permissions

`packages/runtime/src/providers/transports/antigravity-transport.ts` is one mechanism with two open
workstreams: t-ffa1 (keep agy's view_file/list_dir/search inside the workspace) and
t-c8ee (give a read-only reviewer enough capability to verify). One owner changes that
file at a time, and a change to either must state its effect on the other.

### Scratch directories

Every agent uses its own scratch directory and deletes only exact paths. Never run a
glob delete in the shared temp dir: `rm -rf $TMPDIR/alpt-*` can take out another
session's live test scratch, and the victim run then fails with no explanation. Set a
private TMPDIR (for example /tmp/<task>-<agent>) and remove that one directory when you
are done. A writing assignment keeps its scratch under its own worktree.

### Windows: what blocks moving a directory

Windows renames a directory that contains a running executable. Only a process whose
working directory is inside the tree, or a handle opened without delete sharing, prevents
it. Do not write or repeat the claim that a running executable blocks the move: it is
false, it was in `install.ps1`'s refusal message, and a test passed for years only
because its holder happened to have its cwd inside the copy (board finding p-bcd9c956).

### node:test teardown order

`node:test` runs `t.after` hooks FIFO and stops at the first one that throws. A hook that
removes a directory must therefore come AFTER every close/stop/kill hook, or one failed
`rm` silently skips them and the file's process lives until the watchdog kills it at its
deadline — which is how three CI hangs in one night happened. Register teardown in reverse
order of setup through the `defer` helper, which runs every step and rethrows the first
error.

### Budgets for lessons, skills, tasks and issues

The user tightened creation on 2026-11-06 and gave main the numbers below. They are
ceilings on what main may create, not targets to fill. Counts measured that day:
105 user lessons, 18 project lessons, 8 main-created skills, 43 open tasks,
11 open GitHub issues.

- **Skills main created: at most 10.** At 10, main does not ask for an eleventh: it
  merges two overlapping skills or drops one, in the same proposal, and names the
  skills it replaces. A new skill needs three or more lessons on one theme AND no
  existing skill that already covers it; a theme that one existing skill nearly
  covers is a revision of that skill, not a new one.
- **Lessons: at most 40 user-scope and 20 project-scope.** Over the ceiling, main
  curates before recording anything new (`alp_lesson_curate`, user approves each
  change). A lesson is for a rule main will actually follow later; a one-off fact
  belongs in the board or a task note, not in lessons. Pass the verbatim text of
  every lesson a skill replaces, or the lesson survives as a duplicate.
- **Open tasks: at most 25.** Create a task only for work that will plausibly be
  done in the next few sessions. A finding nobody will act on soon is a board
  finding or a GitHub issue, not a task. Over the ceiling, main triages with
  evidence (close as `wontfix`, `duplicate` or `superseded` with a reason) before
  creating more; never mass-close to hit a number.
- **Issues: one draft at a time, P1 or P2 only, with a reproduction.** ALP already
  refuses a second draft while one is pending. If the user declines a draft, the
  whole batch stops and main asks once before proposing another.
- Every count in this section is read in the turn it is quoted, never from memory.
