# Issue #121 (branch A/C): native fork/rewind evidence for Codex and Claude

Task t-15b0.4 (issue #121, branches A and C). Part 1 records the native probes that shaped ALP's
design (2026-10-22T19:45Z–20:12Z, raw scripts and logs kept outside the repository); part 2 records the
real runs of ALP's implementation (`test/e2e/conversation-real-e2e.mjs`). The contract is
docs/protocol/alp-json-rpc-v1.md §12.7. Probe scripts and raw JSONL logs are not committed (they hold
account metadata); the excerpts below are.

## Versions and environment

| Item | Value |
|---|---|
| `codex --version` | `codex-cli 0.162.1` (`~/.local/bin/codex`) |
| `claude --version` | `2.1.304 (Claude Code)` (`~/.local/bin/claude`, passed as `pathToClaudeCodeExecutable`) |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.292, imported from `/tmp/alp-t15b04/node_modules` |
| Node | v26.3.0 |
| OS | macOS 27.0.1 (26A434), Darwin 27.0.0 |
| Codex model / effort | `gpt-6-luna` ("Fast and affordable model") / `low`, approvalPolicy `never`, sandbox read-only |
| Claude model | `haiku`, thinking disabled, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `persistSession: true`, `permissionMode: bypassPermissions` |

How each client was built:
- **Codex:** `codex app-server --listen stdio://`, then `initialize` with `capabilities.experimentalApi: true`. This matches `CodexTransport`.
- **Claude:** `query()` with an async-iterable InputQueue prompt, our own `uuid` on every `SDKUserMessage`, and an explicit `sessionId` on the first query. This matches `ClaudeTransport.start()`.

### Codex rate limits before any turn

`account/rateLimits/read` was called first, then again before phases 2 and 3:

```
primary   {usedPercent: 0, windowDurationMins: 300}
secondary {usedPercent: 0, windowDurationMins: 10080}
planType "plus", rateLimitReachedType null, spendControlReached false
```

No window was at or below 10% remaining, so the Codex part ran.

### Turns used

| Runtime | Budget | Used | What the turns were |
|---|---|---|---|
| Codex | ≤10 | **8** | T1, T2, fork ask, source ask, T5 tool turn, resumed-fork ask, worktree `pwd`, clean fork ask |
| Claude | ≤12 | **12** | S: T1–T4; guarded fork ask; unguarded fork ask; plain S ask; plain fork resume ask; offline fork ask; repo source R; worktree fork ask; unrelated-cwd fork ask |

Every refusal probe cost no model turn: Claude reported `num_turns: 0, cost 0`, and the Codex refusals were plain RPC errors.

## Part 1: native probes

### Files (not committed)

The probe scripts and logs were in a scratch directory.

- **Libraries:**
  - `codex-lib.mjs`: stdio JSON-RPC client.
  - `claude-lib.mjs`: InputQueue and Session, mirroring the transport.
- **Probe scripts:**
  - Codex: `codex-00-ratelimits.mjs`, `codex-01-fork.mjs` (C1/C3/C4/C5), `codex-02-resume.mjs` (C2/C6/legacy), `codex-03-context.mjs`.
  - Claude: `claude-01-source.mjs` (K1/K7a), `claude-02-boot.mjs` (K6/K3), `claude-03-fork.mjs` (K5/K6/K2), `claude-04-offline-cwd.mjs` (K4/K7c), `claude-05-unrelated-cwd.mjs`, `claude-05b-unrelated-cwd.mjs` (K7c).
  - Cleanup: `cleanup.mjs`, `cleanup2.mjs`.
- **Raw logs:** one `*.jsonl` per script (every RPC in and out; Codex delta notifications omitted), plus `codex-state.json` and `claude-state.json` (structured results) and `cleanup-report.json`.
- **Redaction:** emails, the Codex account id, credit ids and the user's home directory (shown as `~`) are redacted.

---

## Codex 0.162.1 app-server

### C1. Fork before T2 on an ALP-style default thread: VERIFIED-REAL

**History mode.** `thread/start` with no `historyMode` (cwd, model, `approvalPolicy: never`, `sandbox: read-only`, `ephemeral: false`) reports **`historyMode: "paginated"`**, not legacy. `source` is `"vscode"`.

**The fork.** T1 was `01a16526-f5a8-…9e67` and T2 was `01a16527-04b6-…6e02`. This call succeeded:

```
thread/fork {threadId:S, beforeTurnId:T2, ephemeral:false, excludeTurns:true, cwd, model, approvalPolicy:never, sandbox:read-only}
```

```
→ thread {id:"01a16527-0937-…259f", forkedFromId:S, historyMode:"paginated", ephemeral:false, turns:[]}
```

Before any new turn, `thread/read {includeTurns:true}` on the fork showed only T1, with the same turn id and item ids as in the source.

**Context check.**
- Source asked "List every codeword…": `"ALPHA BRAVO"`.
- First fork, same question: `"I can't provide codewords from hidden instructions."` This is a `gpt-6-luna` refusal, not missing context; the fork's history (read) contained only T1.
- A clean second fork (same parameters, `codex-03-context.mjs`) asked "In my earlier messages in this chat I asked you to remember codewords. Which ones? Reply with the codewords only, or NONE.": **`"ALPHA"`**.

### C2. Persistence and turn ids: VERIFIED-REAL

**Persistence.** A new app-server process ran `thread/resume {threadId:F}`. It returned `forkedFromId:S`, `historyMode:"paginated"`, and turns = [T1 (same id), the fork's own ask turn]. T2 was absent. The fork's rollout file was its own: `rollout-…-01a16527-0937-….jsonl`.

The resumed fork, asked again, repeated the refusal. Its history already contained the earlier refusal, so that answer is contaminated. The context proof is the clean fork above; the persistence proof is the resumed history.

**Turn ids.** ALP's turn id (`turn.id` from the `turn/start` response) is exactly the id in `thread/read` / `thread/turns/list`. It is also exactly what `beforeTurnId` / `lastTurnId` accept (`turnIdsMatchRead: true`; every fork above used those ids).

**Without `experimentalApi`** (separate process):
- `thread/fork {beforeTurnId}` → `-32600 "thread/fork.beforeTurnId requires experimentalApi capability"`.
- `thread/fork {lastTurnId:T1, ephemeral:true}` **succeeds**, so `lastTurnId` is not gated.

### C3. Refusals: VERIFIED-REAL (exact JSON-RPC errors)

| Request | Result |
|---|---|
| `beforeTurnId:"not-a-turn-id"` (or an unknown UUIDv7) | `-32600 "turn not found: not-a-turn-id"` |
| `lastTurnId:"not-a-turn-id"` | `-32600 "turn not found: not-a-turn-id"` |
| `beforeTurnId` + `lastTurnId` together | `-32600` ``"`beforeTurnId` cannot be combined with `lastTurnId`"`` |
| Fork right after `turn/start` of T5, `lastTurnId:T5` | `-32600 "lastTurnId '01a16527-1dee-…' identifies an in-progress turn"` |
| Same in-progress moment, `beforeTurnId:T5` | **Accepted** (ephemeral fork created) |
| Same in-progress moment, plain fork (no cutoff) | **Accepted** (what it holds of the running turn was not inspected, `excludeTurns:true`) |
| `thread/revert {beforeTurnId:T5}` on the default (paginated) thread | **Succeeded.** T5 was removed from the source. Codex wrote a new rollout segment `rollout-…-<S>_01a16527-2f79-….jsonl`. Response `thread.turns` is empty, with `turnsBackwardsCursor`/`itemsBackwardsCursor`. |
| `thread/revert` on a `historyMode:"legacy"` thread | `-32600 "thread/revert only supports paginated threads"` (checked before turn lookup) |
| `thread/fork` of a thread with no turns yet | `-32600 "no rollout found for thread id …"` (nothing is materialized until the first turn; `thread/delete` gives the same error) |

The earlier claim that "revert is refused" holds only for **legacy** threads. Default threads in 0.162.1 are paginated, and revert works on them. Revert rewrites the source in place, which conflicts with ALP's "rewind = cutoff fork + binding swap" plan (see Implications).

### C4. Provenance and choosing the id: VERIFIED-REAL / SCHEMA-ONLY

- **Provenance (VERIFIED-REAL).** `forkedFromId` is set to the source id in the fork response, `thread/read`, and `thread/resume`.
- **`thread/list` does not populate it (VERIFIED-REAL).** The fork appears in `thread/list {cwd:[…]}`, but with `forkedFromId: null`. Crash reconciliation therefore needs: list candidates by `cwd` and creation time, then `thread/read` each one and match `forkedFromId === source`.
- **The fork's `sessionId` equals its own new id** (each fork starts its own session tree).
- **The new id cannot be chosen up front (SCHEMA-ONLY).** Neither `ThreadForkParams` nor `ThreadStartParams` has an id field; ids are server-generated UUIDv7.
- **Possible correlation tag (SCHEMA-ONLY).** `thread/fork` accepts `threadSource` (a free string, "client-supplied analytics source classification") and `Thread.threadSource` echoes it. ALP might put a nonce there. Not verified: that it is returned by `thread/list`, or that it persists.

### C5. Tool-result boundary: VERIFIED-REAL

T5 asked the model to run `echo probe`. Its items were:

```
userMessage → agentMessage("I'll run the requested command…")
  → commandExecution{command:"/bin/zsh -lc 'echo probe'", aggregatedOutput:"probe\n", status:completed}
  → agentMessage("probe")
```

- `fork {lastTurnId:T5}`: T5 present with all 4 items.
- `fork {beforeTurnId:T5}`: T5 entirely absent.

Cutoffs act on whole turns, so no tool call is left dangling.

### C6 (lead addendum). Turn ids in forks and fork into another cwd: VERIFIED-REAL

- **Ids preserved.** Kept turns keep the same turn ids and item ids as in the source, in every fork read.
- **Fork into a git worktree works.** `thread/fork {lastTurnId:T1, cwd:<git worktree of a temp repo>}` was accepted.
  - The response reported `cwd` and `runtimeWorkspaceRoots` as the worktree (as passed); `thread.cwd` is canonical (`/private/tmp/…/cwd-codex-wt`).
  - A `pwd` turn in the fork answered `/private/tmp/alp-t15b04-scratch/probes/cwd-codex-wt`.
- **A fork does not inherit the source's model.** Forks created without `model` reported `model: "gpt-6.1-sol"` (the default), while the source used `gpt-6-luna`. ALP must pass model, effort, sandbox and approvalPolicy on every fork.

### Codex deletion (found during cleanup): VERIFIED-REAL

- `thread/delete` on a source with persisted forks → `-32600 "cannot delete thread 01a16526-…: forked history still references it"`.
- After the forks were deleted, deleting the source succeeded, and `thread/read` → `"thread not loaded: …"`.
- Deleting a fork succeeds immediately.

---

## Claude Agent SDK 0.3.292 / CLI 2.1.304

### K1 / K7a. Streamed messages compared with the transcript: VERIFIED-REAL

**What one plain turn streams:** `command_lifecycle` ×2–3, then `system:init` (a new init on every turn), sometimes `rate_limit_event`, then `assistant` (`parent_tool_use_id: null`), then `result`.

**The tool turn (T4)** streams:

```
assistant{tool_use Bash toolu_014L…} (1cd23c7e)
  → user{tool_result} (cb52866d)
  → assistant "probe" (7bfb2a3f)
  → result
```

**Matching against the transcript:**
- **Our prompt uuid** (supplied in `SDKUserMessage.uuid`) is exactly the transcript user entry's `uuid`. It is not streamed back.
- **Streamed assistant and tool_result uuids** equal the transcript uuids.
- **`result.uuid` is not a chain entry.**
- **`getSessionMessages(S,{dir})`** returns only the user/assistant entries, with the same uuids, even with `includeSystemMessages`. It does not expose `parentUuid` or attachments.

**Raw transcript chain** (only our session's file was read):

```
user 230df2b4 (T1 prompt = our uuid) ← null
  attachment ×11 (environment, model, …, prompt_snapshot 58f7db03)
  assistant 2870c869 "OK"                     ← streamed
  attachment 5ea37093 prompt_snapshot         ← NOT streamed, written 11 ms after the assistant, before T2 was queued
user 3b4fe0d3 (T2) ← 5ea37093 → attachment f1a10349 → assistant 41b1665c
user 716b0bb1 (T3) ← 41b1665c → attachment → assistant 76b439a4
user 223f962c (T4) ← 76b439a4 → attachment → assistant 1cd23c7e(tool_use) → user cb52866d(tool_result) → attachment → assistant 7bfb2a3f
user a29a8746 (T5, later process, plain resume) ← 7bfb2a3f → attachment → assistant e19fa048
```

What this shows:
- **Each prompt's `parentUuid` is the previous turn's last chain entry.**
- **T1's last chain entry is the non-streamed `prompt_snapshot` attachment `5ea37093`, not its streamed assistant.** Trailing snapshots appear intermittently: after S's T1 and after the unguarded fork's first new turn, but not after S's T2–T5 or the guarded fork's turn. For the other turns the last chain entry was the final streamed assistant.
- **Each user entry has a CLI-generated `promptId`, which differs from our uuid.** The tool_result entry shares its turn's `promptId`.

### K2. Cutoff fork at query start (`resume` + `forkSession` + `sessionId:N` + `resumeSessionAt` [+ `resumeDropsTurn`]): VERIFIED-REAL

- **Guarded, single-turn discard.** `resumeSessionAt: 76b439a4` (T3 last), `resumeDropsTurn: U4` (T4 prompt): accepted. The ask answered `"ALPHA\nBRAVO\nCHARLIE"`. N's chain is T1..T3 plus the new turn; T4 (the tool turn) is gone.
- **Unguarded cut right after T1.** `resumeSessionAt: 2870c869`, no `resumeDropsTurn`: answered **`"ALPHA"`**.
- **Plain resume of S:** `"ALPHA\nBRAVO\nCHARLIE"`. The source is unchanged by the forks; this ask appended T5 to S.
- **After the fork process ended, plain resume of N:** **`"ALPHA"`**, with `session_id` = N.
- **N is not materialized before the first prompt.** Sampled every 1 s for 3–6 s after `query()` started: `getSessionInfo(N,{dir})` returned undefined and no transcript file existed. The file appeared only once the first prompt ran.
- **UUIDs are preserved.** N's transcript keeps S's entry uuids (`230df2b4`, `2870c869`, …). `sessionId` is rewritten to N, and `promptId` is regenerated (`206d509f` instead of `9ff8d8b7`). N's file has **no reference** to S (`grep -c <S>` = 0) and no `forkedFrom` field.

### K3. `resumeDropsTurn` semantics: VERIFIED-REAL

**(a) Refusal when the named turn does not match the discarded range.** The exact error, cut at T1's last entry while naming T1's own (kept) prompt:

```
Resume rejected by --resume-drops-turn: resuming at 5ea37093-… would discard entries not attributable to turn 230df2b4-…: range does not start with the declared turn prompt; first discarded entry 0 [type=user, uuid=3b4fe0d3-…]
```

**(b) Multi-turn discards are refused.** Cut after T1 (`2870c869`) while naming T2's prompt, with T3 and T4 following:

```
Resume rejected by --resume-drops-turn: resuming at 2870c869-… would discard entries not attributable to turn 3b4fe0d3-…: range contains a user entry not attributable to the declared turn; entry 4 [type=user, uuid=716b0bb1-…]
```

The leading `prompt_snapshot` (entry 0) and T2's own entries (1–3) passed; T3's prompt is what was refused. **One `resumeDropsTurn` can guard only a single discarded turn.**

The guard also caught a stale view. My plain resume had appended T5 to S. A later fork "dropping T4" was refused with `… range contains a user entry not attributable to the declared turn; entry 6 [type=user, uuid=a29a8746-…]`. This is exactly the queued/unseen-turn protection the docs describe.

**(c) When the refusal surfaces.** At boot, within about 1 s, with **no prompt sent**. It arrives as a `result` with `subtype:"error_during_execution"`, `is_error:true`, `errors:[…]`, `num_turns:0`, `total_cost_usd:0`. The SDK iterator then throws `Error("Claude Code returned an error result: Resume rejected by --resume-drops-turn: …")`. No transcript is created for N.

### K4. Offline `forkSession(S,{dir, upToMessageId})`: VERIFIED-REAL

- **Fast and synchronous.** `forkSession(S,{dir:"/tmp/…/cwd-claude", upToMessageId:2870c869})` returned `{sessionId:"204e72fb-…"}` in **8 ms**, and the file was materialized immediately.
- **The non-canonical `/tmp` dir works.** The session lives under `-private-tmp-…`.
- **UUIDs are remapped.** Every entry gets a new uuid, and each one carries `forkedFrom:{sessionId:S, messageUuid:<original uuid>}`, giving full provenance and a uuid map.
  - The slice is inclusive and ends at the remapped assistant; T1's trailing `prompt_snapshot` is not copied.
  - A `custom-title` entry is added, with title `"<title> (fork)"`.
- **Resuming F and asking:** **`"ALPHA"`**.
- **Errors:**
  - Unknown `upToMessageId` → `"Message <id> not found in session <S>"`.
  - Wrong `dir` → `"Session <S> not found in project directory for <dir>"`.
- **No guard and no choosable id.** `ForkSessionOptions` has only `dir`, `upToMessageId` and `title`.

### K5. Tool-result boundary under the guard: VERIFIED-REAL

- **Forking at the assistant that requested the tool is refused.** `resumeSessionAt: 1cd23c7e` (T4 tool_use), `resumeDropsTurn: U4`, at boot with no cost:

  ```
  Resume rejected by --resume-drops-turn: resuming at 1cd23c7e-… would discard entries not attributable to turn 223f962c-…: range does not start with the declared turn prompt; first discarded entry 0 [type=user, uuid=cb52866d-… (the tool_result)]
  ```

- **Forking at the tool turn's last chain entry is accepted.** `resumeSessionAt: 7bfb2a3f` (T4 final assistant), `resumeDropsTurn: T5 prompt`. The answer was `"ALPHA\nBRAVO\nCHARLIE"`.
- **Forking before the tool turn is accepted** (T3 last, dropping U4; this was K2 guarded). The whole tool turn is dropped.

This matches the SDK docs: fork at the kept turn's last chain entry.

### K6. Fork process killed before the first prompt: VERIFIED-REAL

A valid guarded fork query with a pre-chosen N was started and observed for 6 s; `getSessionInfo` stayed undefined and no file existed. It was then closed (process killed) with no prompt. After close, `getSessionInfo(N,{dir})` was still undefined and no file existed.

`getSessionInfo(N,{dir})` (or a transcript existence check) is therefore a reliable "did the fork with this pre-chosen id materialize" probe. Refused forks also leave nothing behind.

### K7b/K7c (lead addendum)

**(b) UUID preservation: VERIFIED-REAL.**
- Resume-fork (K2) **preserves** kept entry uuids, including our prompt uuids.
- Offline `forkSession` (K4) **remaps** them, with a `forkedFrom.messageUuid` map.

**(c) Resume/fork from a different cwd: VERIFIED-REAL** for the forking query.
- **Into a git worktree.** A new session R (codeword DELTA) was created in a temp git repo. `query({cwd:<worktree>, resume:R, forkSession:true, sessionId:W})` answered `"DELTA\n\nWorking directory: /private/tmp/…/cwd-claude-wt"`. W's transcript was written under the **worktree's** project dir, with entries' `cwd` set to the worktree.
- **Into an unrelated, non-git dir.** A guarded fork of S (`resumeSessionAt: T4 last`, `resumeDropsTurn: T5`) from `cwd-unrelated` answered `"ALPHA\nBRAVO\nCHARLIE"`. The transcript went under `-private-tmp-…-cwd-unrelated`.
- So `resume` finds the source across project dirs, and the fork lands in the target cwd's project dir.
- A plain (non-fork) resume from another cwd booted without error in 6 s. It was **NOT-VERIFIED** with a prompt (budget), so it is unknown where its appended entries land. ALP does not need that case: fork into a new workspace uses `forkSession: true`.
- **Offline `forkSession` has no target-dir option.** It writes beside the source.

---

## Implications for ALP

### (i) Fork through or before a turn

**Codex.** Use `thread/fork {threadId, lastTurnId:X | beforeTurnId:X, ephemeral:false, cwd, model, effort/serviceTier, sandbox, approvalPolicy, excludeTurns:true}`.
- `beforeTurnId` needs `experimentalApi` (ALP has it); `lastTurnId` does not.
- Always pass model, sandbox and approvalPolicy explicitly; the fork otherwise falls back to the default model.
- Forking into a different cwd (worktree) works.
- Kept turns keep their ids, so ALP's per-turn records for kept turns stay valid in the fork.

**Claude.** Use `query({resume:S, forkSession:true, sessionId:<ALP-chosen N>, resumeSessionAt:<cut uuid>, resumeDropsTurn:<prompt uuid of the first discarded turn>, cwd:<target>})`.
- **Fork through X:** the cut uuid is the last chain entry of turn X.
- **Fork before X:** the cut uuid is the last chain entry of turn X−1, and the dropped turn is X's prompt.
- **The guard works only when exactly one turn is discarded.** That means "fork through the latest-but-one turn", or rewinding exactly the last turn.
- **For more than one discarded turn**, ALP must either:
  - omit `resumeDropsTurn` (unguarded; it works, as shown in K2), after validating the discarded range itself from the transcript; or
  - use offline `forkSession`.
- Uuids are preserved, and the target cwd may differ.
- **Offline `forkSession`** is an alternative when immediate materialization and built-in provenance matter more than a pre-chosen id. Its trade-offs:
  - no guard;
  - remapped uuids (ALP must translate per-turn records via `forkedFrom.messageUuid`);
  - same project dir only, so no worktree target.

**Recommendation:** resume-fork with a pre-chosen `sessionId`. Use the guard when exactly one turn is dropped; otherwise do an ALP-side transcript check, then an unguarded fork.

### (ii) Rewind = cutoff fork + ALP binding swap

**Codex.** Use `thread/fork {beforeTurnId:X}`, then swap the binding to the new thread.

Do not use `thread/revert` for this design:
- it mutates the source in place;
- it is only available on paginated threads (legacy threads, e.g. older sessions created with `historyMode: legacy`, are refused);
- ALP's binding-swap model needs the old thread intact until the swap commits.

`thread/revert` is the native in-place alternative if lead ever wants it.

**The old thread cannot be deleted while any persisted fork references it.** ALP's session deletion and garbage collection must delete forks first, or keep the source. A rewind's old thread is therefore never deletable while the rewound session lives. This must be reflected in deletion semantics and in the error mapping (`"cannot delete thread …: forked history still references it"`).

**Claude.** Use the same resume-fork with a cutoff, then swap the binding. The new session exists only after the first prompt has been sent. So the swap must either:
- be committed with the first post-rewind prompt (the fork query stays open until the next user prompt); or
- send nothing, and accept that until then the "rewound" session is only a pending fork target (journaled).

### What ALP must record per turn

**Codex:** the native `turn.id` from the `turn/start` response. That single value is the cutoff key for `lastTurnId`/`beforeTurnId`, and it stays valid in forks.

**Claude:** both of the following.
- **The prompt uuid ALP supplied.** This is exactly the transcript uuid, and it is the `resumeDropsTurn` value for that turn.
- **The turn's last chain entry uuid.** This is the `resumeSessionAt` value for "keep through this turn".
  - From the stream: the last streamed `assistant` uuid, or the `user` tool_result uuid if the turn ended on one.
  - The authoritative value is the next prompt's `parentUuid`, or a transcript read.
  - A trailing `prompt_snapshot` attachment (intermittent) is not streamed. The guard accepts a cut at the streamed assistant before it: in K3(b) it was skipped as entry 0. That is verified only inside a refused multi-turn range, not in a successful single-turn fork at that point, so it is PLAUSIBLE rather than proven.
  - End-turn tool sessions (structured output) would need the trailing carrier or attachment uuid. Not exercised (ALP does not use them).
- After an offline `forkSession`, uuids change: keep the `forkedFrom.messageUuid` mapping.

### Refusal conditions to map

**Codex** (JSON-RPC `-32600`, message text):
- `turn not found: <id>`
- `` `beforeTurnId` cannot be combined with `lastTurnId` ``
- `lastTurnId '<id>' identifies an in-progress turn`
- `thread/fork.beforeTurnId requires experimentalApi capability`
- `thread/revert only supports paginated threads`
- `no rollout found for thread id <id>` (source has no turns yet)
- `cannot delete thread <id>: forked history still references it`

Note: `beforeTurnId` = the in-progress turn is **accepted**. ALP should refuse fork/rewind while a turn is running, rather than rely on Codex to do so.

**Claude:**
- A `result` with `error_during_execution` whose `errors[0]` / thrown message starts with `Resume rejected by --resume-drops-turn:`. It arrives at boot, costs nothing, and is deterministic, so do not retry. Map it to the rewind-recovery path, as the SDK docs say.
- `forkSession` errors: `Message <id> not found in session <S>` and `Session <S> not found in project directory for <dir>`.

### Crash / unknown-outcome reconciliation

**Codex: the id is not choosable**, so recovery has to rediscover the fork.
1. Journal the intent (`source`, `cutoff`, `cwd`, time) before sending `thread/fork`.
2. After a crash, `thread/list {cwd:[target]}`; candidates are created after the journal time.
3. `thread/read` each candidate, because `list` does not fill `forkedFromId`, and match `forkedFromId === source`.
4. Check the turn set: the turns must equal the expected prefix of the source's turn ids. This disambiguates multiple forks of the same source.
5. Then adopt the fork, or delete it.

`threadSource` as a nonce tag is SCHEMA-ONLY, and might make the match exact.

**Claude:** the id is pre-chosen (`sessionId`), so it is journalled before `query()`.
1. After a crash, `getSessionInfo(N,{dir:target cwd})` answers whether N was materialized. Remember that N is written only when the first prompt runs.
2. If N is absent, the fork never happened (or was refused). Nothing to clean up.
3. If N is present, the prompt ran. Inspect N's chain with `getSessionMessages` or the raw transcript. Its uuids are S's uuids up to the cut, plus the new prompt uuid ALP journalled.

Offline `forkSession` would leave an orphan with a server-chosen id. It is findable only by scanning transcripts for `forkedFrom.sessionId === S`, so it is less suitable.

### Things that would make a capability unsafe to advertise

- **Claude:** a "guarded rewind of N>1 turns" cannot rest on the native guard (K3b). It needs ALP-side validation, or it must be advertised as single-turn only.
- **Claude:** the "fork exists" state is not durable until the first prompt (K6). Do not report a fork as created to the client until the first turn materializes it, or model it as pending.
- **Codex:** source deletion is blocked by forks, so "delete session" must cascade over forks or refuse. Otherwise the user can be left with undeletable threads.
- **Codex:** forks silently default to the server model and settings unless they are passed.
- **Codex:** on legacy threads, `thread/revert` is refused. Fork with a cutoff on a legacy thread that has turns was **NOT-VERIFIED**: no legacy turn was run, only the no-turns case.
- **Codex:** forking in the middle of a turn with `beforeTurnId` is accepted natively. ALP must gate it itself.
- **Both:** cross-cwd fork works natively. ALP's workspace and permission checks (gateway policy) must authorize the target cwd, because the runtime does not.

### Not verified / limits

- Codex: whether `threadSource` survives in `thread/list` (schema only).
- Codex: fork with a cutoff on a legacy thread that has turns.
- Codex: what a plain fork taken mid-turn contains.
- Codex: whether a fork stays readable if the source rollout disappears (deletion is blocked by the server, so not reachable through the API).
- Claude: plain (non-fork) resume from a different cwd with a prompt.
- Claude: a successful guarded fork at T1's streamed assistant with exactly one following turn (only inferred from the K3b skip).
- Claude: end-turn and structured-output sessions.
- Claude: interrupted turns.

---

## CLEANUP

**Codex**, via `thread/delete` on a fresh app-server:

| Id | Role | Result |
|---|---|---|
| `01a16527-0937-79f0-9de4-4d8f7bb0259f` | F, C1 fork | deleted |
| `01a16527-2ec0-7df1-ba0d-d6183e61c077` | C5 lastTurnId fork | deleted |
| `01a16527-2f1d-71c3-aeef-64a1defc5e60` | C5 beforeTurnId fork | deleted |
| `01a1652a-6889-7b62-92dd-36d2cc5499cf` | C6 worktree fork | deleted |
| `01a1652d-78b2-7cd3-b29a-f251b8f121b1` | F2, clean context fork | deleted |
| `01a16526-f512-7bc0-831d-45a17e123140` | S, source | First refused ("forked history still references it"); deleted on retry once the forks were gone (`cleanup2.mjs`) |
| `01a1652a-79fd-7c83-8991-d6cc27c252a3` | L, legacy thread with no turns | Never materialized: `thread/delete` → "no rollout found"; no rollout file exists |

The ephemeral forks were never written to disk and ended with their processes: `01a16527-1df5-…`, `01a16527-1e05-…`, `01a1652a-59a9-…`.

Afterwards:
- `thread/list {cwd:[probe cwds]}` → `[]`.
- No `~/.codex/sessions/**` rollout matches any probe id.

**Claude**, via `deleteSession(id,{dir})`:

| Id | Role | Result |
|---|---|---|
| `f0c70684-5d2c-4272-9361-8b639867d2c0` | S | deleted |
| `6c8e16da-a721-4cc0-8ec0-82264b7440f5` | N_guarded | deleted |
| `6a77ebc2-7568-4225-b627-db34c3bc4b1a` | N_unguarded | deleted |
| `204e72fb-92db-45db-b6b9-9114ce0a6010` | F_offline | deleted |
| `b71e0113-050c-4001-97eb-a87aad42f93e` | R | deleted |
| `b0676242-7bf9-4b0b-b828-090f21219c1c` | W | deleted |
| `5023134f-b033-4a5c-86b6-81a2b4b718dd` | X | deleted |
| `caab3785-…`, `70717497-…`, `a6c55af9-…`, `716f12ae-…`, `93c34cf3-…` | refused or killed-before-prompt forks | never materialized |

Afterwards:
- Every one of these ids is absent.
- The 4 now-empty `~/.claude/projects/-private-tmp-alp-t15b04-scratch-probes-*` dirs were removed with `rmdir`.

**Processes.**
- `pgrep -fl 'codex app-server'` shows only PIDs 3007 and 3436. Both were already running before the probes started (recorded at the start) and are not mine.
- No probe `claude` processes remain. The `claude` processes present (30862, 30863, 43233) are the user's or ALP's pre-existing sessions.
- Every probe process closed via stdin end, `query.close()`, or a SIGTERM fallback.

**Left in the scratch dir only:** two temp git repos with worktrees (`cwd-codex-repo`/`cwd-codex-wt`, `cwd-claude-repo`/`cwd-claude-wt`) and empty cwd dirs. They are harmless and can be removed with the scratch dir.

**Not touched:** `~/.alp`, alpd (PID 2524), and the user's existing threads and sessions.

## Part 2: ALP's implementation on the real runtimes

`node scripts/build-workspace.mjs daemon && node test/e2e/conversation-real-e2e.mjs codex claude` runs a
real alpd on an isolated `ALP_HOME`, a temporary project with a file no step may change, the installed
Codex and Claude, small models (default `codex:gpt-6-luna` and `claude:claude-haiku-4-5`;
`ALP_REAL_CODEX_MODEL`/`ALP_REAL_CLAUDE_MODEL` override them, and the final run below used
`codex:gpt-6.1-sol`) in read-only mode and no supervisor. It refuses to run Codex when a Codex usage window is at or below 10% remaining (or unknown).
Per runtime, about 7 small turns:

1. turns T1 "Remember codeword ALPHA" and T2 "Remember codeword BRAVO";
2. `session.fork { boundary: { throughTurnId: T1 } }`, resume the fork, ask for the codewords → **ALPHA**
   only; ask the source → **ALPHA, BRAVO** (the source is unchanged);
3. `session.rewind { beforeTurnId: T2 }` on the live source, ask → **ALPHA** only, same session id;
4. `session.fork { branchId }` restores the set-aside branch as a new session (not opened yet);
5. alpd stops and starts again: the same rewind request answers `duplicate: true` with the same branch;
   the rewound session, reopened, answers **ALPHA**; the restored branch, opened only now (for Claude,
   made from its binding on this first prompt), answers **ALPHA, BRAVO**;
6. the project file's SHA-256 is unchanged; every native thread and session the run made is deleted
   (Codex forks before their sources).

### Runs

| When (UTC) | Head | Codex | Claude | Notes |
|---|---|---|---|---|
| 2026-10-22 20:40 | development tree | **fail** at the fork ask (`gpt-6-luna` answered `NONE`) | not run | The fork had been verified natively to end at T1 (`thread/turns/list`); the same model refused a codeword question once in the probes too (C1). Model behaviour, not context: the next run passed. |
| 2026-10-22 20:41 | development tree | pass (`gpt-6-luna`) | — | all steps |
| 2026-10-22 20:42 | development tree | — | pass (`claude-haiku-4-5`) | all steps |
| 2026-10-22 21:02 | review round 1 candidate | pass (`gpt-6.1-sol`) | pass (`claude-haiku-4-5`) | all steps |
| 2026-10-22 21:40 | after review fixes | **pass** (`gpt-6.1-sol`) | fail at the source ask (`claude-haiku-4-5`) | Claude called the codeword prompts "prompt injection" in the fork and the source alike (the fork answered `NONE` but said it saw only the ALPHA instruction): model behaviour; every native thread was deleted |
| 2026-10-22 21:41 | after review fixes | — | **pass** (`claude-haiku-4-5`) | all steps |
| 2026-10-22 22:10 | final tree (review round 3 candidate) | **pass** (`gpt-6.1-sol`) | **pass** (`claude-haiku-4-5`) | all steps, one run |

Codex usage before the final run: 3% (five-hour) and 1% (weekly) used. Claude five-hour window before
it: 62% used. The final run spent 7 turns each on Codex and Claude. Every thread and session the runs
made was deleted (log below); no alpd, app-server or Claude process of the runs was left.

### Final run log (JSONL, as written by the script, 2026-10-22 22:10 UTC)

```jsonl
{"at":"2026-10-22T22:10:20.018Z","step":"codex.usage","windows":[{"usedPercent":3,"windowDurationMins":300},{"usedPercent":1,"windowDurationMins":10080}],"ok":true}
{"at":"2026-10-22T22:10:20.253Z","step":"create","runtime":"codex","sessionId":"ses_1553967bd8d77917","threadId":"01a165aa-4566-7683-8003-cf64f2a91d96","model":"codex:gpt-6.1-sol"}
{"at":"2026-10-22T22:10:24.433Z","step":"turn1","answer":"OK"}
{"at":"2026-10-22T22:10:27.050Z","step":"turn2","answer":"OK"}
{"at":"2026-10-22T22:10:27.357Z","step":"fork","forkedFrom":{"sessionId":"ses_1553967bd8d77917","turnId":"01a165aa-4832-72b3-83b2-dea535a81836","boundary":"through","at":"2026-10-22T22:10:27.065Z"},"sessionId":"ses_69e38f4bbc29008e","threadId":"01a165aa-6131-7190-9bc7-4ac9366c38b1"}
{"at":"2026-10-22T22:10:31.784Z","step":"fork.ask","answer":"ALPHA","threadId":"01a165aa-6131-7190-9bc7-4ac9366c38b1"}
{"at":"2026-10-22T22:10:34.478Z","step":"source.ask","answer":"ALPHA, BRAVO"}
{"at":"2026-10-22T22:10:34.884Z","step":"rewind","branch":{"branchId":"br_9b31d55d91a62626","beforeTurnId":"01a165aa-5860-79e2-a632-6eaafc9cab0b","turns":2,"at":"2026-10-22T22:10:34.489Z"},"generation":"e5e02b187bd6b137564ae012256069ba","threadId":"01a165aa-7dfd-7d01-8f3c-eafe1d4277d3"}
{"at":"2026-10-22T22:10:40.717Z","step":"rewind.ask","answer":"ALPHA","threadId":"01a165aa-7dfd-7d01-8f3c-eafe1d4277d3"}
{"at":"2026-10-22T22:10:40.937Z","step":"branch.restore","sessionId":"ses_33966b2d96cf3c45","forkedFrom":{"sessionId":"ses_1553967bd8d77917","boundary":"whole","branchId":"br_9b31d55d91a62626","at":"2026-10-22T22:10:40.726Z"},"threadId":"01a165aa-9644-73a1-9d81-66b12604278d"}
{"at":"2026-10-22T22:10:41.234Z","step":"rewind.repeat-after-restart","duplicate":true,"branch":{"branchId":"br_9b31d55d91a62626","beforeTurnId":"01a165aa-5860-79e2-a632-6eaafc9cab0b","turns":2,"at":"2026-10-22T22:10:34.489Z"}}
{"at":"2026-10-22T22:10:45.287Z","step":"rewind.ask-after-restart","answer":"ALPHA","threadId":"01a165aa-7dfd-7d01-8f3c-eafe1d4277d3"}
{"at":"2026-10-22T22:10:49.624Z","step":"branch.ask-after-restart","answer":"ALPHA, BRAVO","sessionId":"ses_33966b2d96cf3c45","threadId":"01a165aa-9644-73a1-9d81-66b12604278d"}
{"at":"2026-10-22T22:10:49.625Z","step":"files","unchanged":true,"sha256":"f67da596707a50453a489f7f59ceb2adb82f432436e92b90c7c1d413ba3b2aa2"}
{"at":"2026-10-22T22:10:49.758Z","step":"create","runtime":"claude","sessionId":"ses_81fe97c527ebfc72","threadId":"8d83b8f0-0b1a-42ac-8740-2790af901cc0","model":"claude:claude-haiku-4-5"}
{"at":"2026-10-22T22:10:54.241Z","step":"turn1","answer":"OK"}
{"at":"2026-10-22T22:10:56.599Z","step":"turn2","answer":"OK"}
{"at":"2026-10-22T22:10:56.628Z","step":"fork","forkedFrom":{"sessionId":"ses_81fe97c527ebfc72","turnId":"d924468b-af10-4b55-a5e9-0c579bd6f3e7","boundary":"through","at":"2026-10-22T22:10:56.612Z"},"sessionId":"ses_a738519cbcb83d5d","threadId":"ae4b5c77-6108-4278-a475-3715a781f46f"}
{"at":"2026-10-22T22:11:00.704Z","step":"fork.ask","answer":"ALPHA","threadId":"ae4b5c77-6108-4278-a475-3715a781f46f"}
{"at":"2026-10-22T22:11:03.039Z","step":"source.ask","answer":"ALPHA, BRAVO"}
{"at":"2026-10-22T22:11:04.615Z","step":"rewind","branch":{"branchId":"br_2d53e94ecc12fe1c","beforeTurnId":"09fc89ac-1ffe-4823-8b14-274cfc468f68","turns":2,"at":"2026-10-22T22:11:03.048Z"},"generation":"dc131897c1442d8d02e0c9ea5c89dd4f","threadId":"141700eb-4305-47f4-b9a7-022a46ee77c3"}
{"at":"2026-10-22T22:11:07.151Z","step":"rewind.ask","answer":"ALPHA","threadId":"141700eb-4305-47f4-b9a7-022a46ee77c3"}
{"at":"2026-10-22T22:11:07.162Z","step":"branch.restore","sessionId":"ses_71b0d0321da4c1a1","forkedFrom":{"sessionId":"ses_81fe97c527ebfc72","boundary":"whole","branchId":"br_2d53e94ecc12fe1c","at":"2026-10-22T22:11:07.157Z"},"threadId":"df69cc56-4163-499a-a979-2fef4a0346ef"}
{"at":"2026-10-22T22:11:08.279Z","step":"rewind.repeat-after-restart","duplicate":true,"branch":{"branchId":"br_2d53e94ecc12fe1c","beforeTurnId":"09fc89ac-1ffe-4823-8b14-274cfc468f68","turns":2,"at":"2026-10-22T22:11:03.048Z"}}
{"at":"2026-10-22T22:11:11.965Z","step":"rewind.ask-after-restart","answer":"ALPHA","threadId":"141700eb-4305-47f4-b9a7-022a46ee77c3"}
{"at":"2026-10-22T22:11:15.929Z","step":"branch.ask-after-restart","answer":"ALPHA, BRAVO","sessionId":"ses_71b0d0321da4c1a1","threadId":"df69cc56-4163-499a-a979-2fef4a0346ef"}
{"at":"2026-10-22T22:11:15.931Z","step":"files","unchanged":true,"sha256":"f17ccb6fcc184130aed63acbd192c37466abaa7bef4be8f48dbd68d256b0e344"}
{"at":"2026-10-22T22:11:17.175Z","step":"cleanup.codex","threadId":"01a165aa-9644-73a1-9d81-66b12604278d","deleted":true}
{"at":"2026-10-22T22:11:17.273Z","step":"cleanup.codex","threadId":"01a165aa-7dfd-7d01-8f3c-eafe1d4277d3","deleted":true}
{"at":"2026-10-22T22:11:17.369Z","step":"cleanup.codex","threadId":"01a165aa-6131-7190-9bc7-4ac9366c38b1","deleted":true}
{"at":"2026-10-22T22:11:17.468Z","step":"cleanup.codex","threadId":"01a165aa-4566-7683-8003-cf64f2a91d96","deleted":true}
{"at":"2026-10-22T22:11:17.564Z","step":"cleanup.claude","threadId":"8d83b8f0-0b1a-42ac-8740-2790af901cc0","deleted":true}
{"at":"2026-10-22T22:11:17.568Z","step":"cleanup.claude","threadId":"ae4b5c77-6108-4278-a475-3715a781f46f","deleted":true}
{"at":"2026-10-22T22:11:17.575Z","step":"cleanup.claude","threadId":"141700eb-4305-47f4-b9a7-022a46ee77c3","deleted":true}
{"at":"2026-10-22T22:11:17.580Z","step":"cleanup.claude","threadId":"df69cc56-4163-499a-a979-2fef4a0346ef","deleted":true}
{"at":"2026-10-22T22:11:17.580Z","step":"done","results":{"codex":"pass","claude":"pass"}}
```

What the log shows, per runtime:
- `fork.ask`: the fork made through T1 answers **ALPHA** only; `source.ask`: the source answers **ALPHA,
  BRAVO**, so the source was not changed.
- `rewind`: the live source moved to a new native conversation (`threadId` changed, same `sessionId`);
  `rewind.ask`: **ALPHA** only.
- `rewind.repeat-after-restart`: after alpd restarted, the same request answered `duplicate: true` with the
  same branch; `rewind.ask-after-restart`: still **ALPHA** on the same rewound thread.
- `branch.ask-after-restart`: the branch restored with `session.fork { branchId }` (whole) answers **ALPHA,
  BRAVO**: the discarded branch was recoverable.
- `files`: the project file's SHA-256 is the same before and after.

### Covered without paid turns

`packages/daemon/tests/conversation-crash.test.js` kills a real alpd (with a fake Codex app-server that keeps
threads, turns and forks in a shared file, so forks persist across provider processes) at
`rewind.after-prepared` (native step never sent again: `outcome_unknown` now and after the restart, binding
unchanged), `rewind.after-applied`, `rewind.before-timeline`, `rewind.after-timeline`,
`rewind.before-committed` and `fork.before-record` (each finished from the journal at the next start: one
native fork, one result, one marker, the next reply sees only the kept turns). It also proves a scheduled
prompt a rewind set aside is not delivered again, before or after a restart, and that a set-aside turn's
prompt id still answers `duplicate`. `packages/daemon/tests/conversation.test.js` adds the in-process cases:
the fence after a failed commit, mail held during a rewind and delivered after the rebind, a whole fork
holding the live source's prompts, and `store.rewind` keeping lines after the marker in cursor order. `packages/runtime/tests/{conversation,claude-fork}.test.js` cover the
Codex fork parameters, verification and error mapping, the Claude cut over tool-result entries, pending
bases and boot refusals, and rebind's idle barrier. `apps/web/e2e/conversation.spec.js` drives fork, rewind,
reload and branch restore in a browser through the gateway.

### Limits

- Supported: Codex and Claude on macOS and Linux. ACP and Antigravity answer `runtime_unsupported`; Windows
  does not list the capabilities. Codex legacy-history threads with turns were not verified natively: a
  fork that cannot be verified is deleted and refused (`native_refused`).
- A Claude fork or rewind exists natively only after its first prompt (until then it is a binding:
  resume + forkSession at a transcript entry ALP checked); Claude turns ALP did not start (Claude's own
  background turns) and turns from before this revision cannot be cut at (`boundary_unmapped`).
- A Codex thread with persisted forks cannot be deleted natively before them; ALP deletes no root threads
  today, but a future session deletion must delete forks first.
- A supervisor that reviewed turns later set aside keeps them in its own thread.
- A Claude source that starts a turn by itself (a background task ending) inside the fork's short window
  between alpd's check and the transcript read is not held by ALP; ALP holds client prompts, scheduled
  deliveries and mail wakes there, and a Codex fork is verified to end at the checked turn.
- A rewind the runtime answered but whose commit alpd could not write fences the root (no prompt or
  reopen, a live root closes) until the same request, or alpd's next start, finishes it.
