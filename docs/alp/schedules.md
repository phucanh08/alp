# One-shot scheduled continuations

## Scheduled continuations

A one-shot job wakes an existing main/root session at an absolute time without another
user message. Keep alpd running (a login service is optional); stopping alpd delays the
wake until it starts again. The job uses the target session's permissions and approval
rules. It grants no additional authority.

```sh
alp schedule create --session SESSION_ID --at '2026-10-21T09:00:00+07:00' --prompt 'Recheck actual provider availability, then continue the approved task.' --project /absolute/project --json
alp schedule list --project /absolute/project --json
alp schedule show sch_0123456789abcdef --project /absolute/project --json
alp schedule cancel sch_0123456789abcdef --project /absolute/project --json
```

`--at` requires seconds and `Z` or an explicit UTC offset. The offset identifies the
instant; daylight-saving transitions do not reinterpret an already saved job. Output
uses UTC. `--session` is required: no session is guessed or created. `--prompt` is the
exact continuation (1–8000 characters). `--status` filters list results; `--json`
returns the protocol result including timestamps, attempts, lateness and lastError.
Past timestamps are caught up on the next tick, with the delay stated in the prompt.

Main's `alp_schedule` tool offers create/list/get/cancel. It binds project and target
to the invoking main root, and create first returns `pending_approval`. The existing
user-question mechanism shows the exact time, session and prompt; approval creates
it once. Rejecting or interrupting the session creates nothing. `requestId` identifies
an approval draft; replay it only unchanged. A resolved proposal is returned again,
without a second job within the live runtime. Proposal approvals are not restored after a daemon restart; inspect existing jobs before proposing again, and obtain a new user decision. CLI creation is an explicit user command and needs no separate
agent approval proposal.

Jobs are `pending`, `delivered`, `failed` or `cancelled`. Delivered means the provider
acknowledged starting the prompt, not that the requested work completed. Busy sessions
wait for the current turn (up to one hour after the deadline); recovery opening waits
up to one hour from its first observed opening. Closed sessions fail with a reason.
Cancellation only succeeds while pending and before delivery starts. Inspect errors
rather than recreating a job automatically. Unknown outcomes and refusals are terminal;
there is no automatic retry of a terminal job. A crash may replay a pending delivery
using the same durable receipt and message id; it never intentionally sends a second
copy. An uncertain crash window fails as outcome_unknown rather than risking a repeat. If a previous attempt has no receipt (including receipt retention expiry), it also fails closed instead of sending again.

Delivery waiting times out after two minutes. `failed` with `delivery_timeout` means
execution is unknown: it does not cancel the outstanding provider request. A late
acknowledgement may still start a turn; inspection then shows `delivery_accepted_late`
while the status stays failed. No retry is sent. Check the session before taking action.

Jobs persist atomically in `$ALP_HOME/schedules/`, outside the versioned state schema.
After daemon restart, a resumable session needed by a pending job is reopened; missing
threads or provider recovery errors are visible failures. Sleep or daemon downtime
causes a catch-up wake, with elapsed lateness in its prompt. A restart cannot restore a
session that did not retain a native thread.

For quota-reset continuations, the resumed agent must recheck actual provider
availability before delegating. Each turn receives a fresh runtime usage snapshot;
missing usage is uncertain. The scheduled time never guarantees quota and does not
change `limits.autoResume`.

A task timer gate merely makes a task eligible when its time passes; it does not wake
main. Assignment notes describe work and may ride with a later turn; they are not
scheduled continuations. Jobs are local to alpd; the remote gateway prohibits all
`schedule.*` methods. There is no recurring/cron support.
