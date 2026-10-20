# ALP JSON-RPC protocol v1

The contract between alpd and its clients (CLI, SDK, Paseo integration, web bridge, ACP adapter),
written so that a client or a daemon in any language, such as Rust, can implement it. Section numbers
are referenced from code; keep them stable.

Status: **v1, normative.** It describes what alpd does at the commit that adds this file, with the
changes listed in §13. Where earlier alpd behaved differently, §13 says so.

## 1. Sources of truth

| Artifact | Role |
|---|---|
| `packages/protocol/schema/methods-v1.json` | **Normative.** Params and result of every supported method, error codes, capabilities, shared definitions (`$defs`). |
| `packages/protocol/schema/ipc-v1.json` | Normative message schema (request, response, event notification); its `$defs` are identical to the methods file's (tested). |
| This document | Normative for everything a schema cannot say: framing, ordering, semantics, error order. |
| `packages/protocol/src/*.ts`, `wire.js` | TypeScript projection and constants. Tests type-check the golden fixtures against it to detect covered differences from the schema. |
| `packages/protocol/fixtures/v1/cases.json` | Golden values: valid and invalid messages, envelopes, params and results of every method. |
| `packages/protocol/conformance/` | Executable suite run against a live endpoint (§11). |
| `src/contract-v1.js` | Generated from `methods-v1.json` (`node packages/protocol/scripts/generate.mjs`); a test fails when stale. |

A shape is changed in the schema first. The schema is not changed to make TypeScript convenient.

## 2. Versions

Four independent numbers; none implies another.

| Version | Value | Where | Changes when |
|---|---|---|---|
| JSON-RPC | `"2.0"` | `jsonrpc` of every message | never |
| ALP protocol | `1` | `daemon.hello` `protocolVersion`, `PROTOCOL_VERSION` | an incompatible wire change (§6.3) |
| Package versions | e.g. `0.10.0` | npm packages, `daemonVersion` | every release; **never** a feature signal |
| Storage | `state/schema.json` = 2; record/receipt `version: 1` | daemon home (ALPD §68) | a storage migration; invisible on the wire |

Features within v1 are negotiated with capabilities (§6.2), never inferred from `daemonVersion` or a
package version.

## 3. Messages

Every message is one JSON object of JSON-RPC 2.0.

- **Request**: `{ "jsonrpc": "2.0", "id": Id, "method": string, "params"?: object }`.
  `params`, when present, is an object; arrays, `null` and scalars fail with `-32602`.
- **Id**: a string of at most 128 Unicode code points, or an integer in
  [-(2^53-1), 2^53-1]. Anything else (null, fractional, boolean, object, larger integers) fails with
  `-32600`, answered with `id: null`; the request does not run.
- **Notification** (a request without `id`): v1 defines none from a client to the daemon. The daemon
  drops one **without running it** and does not answer (JSON-RPC forbids answering notifications).
  The daemon sends one notification: `event` (§8).
- **Response**: `{ "jsonrpc": "2.0", "id": Id | null, "result": any }` or with `"error"`; exactly one of
  the two. `id` is the request's id, or `null` when the request's id was unusable or the frame was
  not a request at all.
- **Correlation**: requests on one connection run concurrently; answers may come in any order and
  events may come between them. A client keeps ids unique among its in-flight requests on a
  connection; the daemon does not check this.
- **Batches** (a JSON array) are not supported: the daemon answers one `-32600` with
  `data.reason: "batch_unsupported"` and `id: null`, and runs none of the batched requests.
- **Daemon-to-client requests**: the only one is `extension.invoke { method, params }`, sent to the
  connection that registered an extension method (capability `extension.methods`). Its ids are
  positive integers chosen by the daemon. The client answers with a response; a client that does not
  serve requests answers `-32601`. A frame without `method` from a client is a response to such a
  request: an unknown id, a missing id, or a frame with both or neither of `result`/`error` is dropped
  silently.

## 4. Framing and transports

JSON-RPC messages are independent of how they are carried.

- **IPC stream** (Unix socket, Windows named pipe; ALPD §3): UTF-8, one JSON text per frame, each frame
  terminated by `\n` (LF). Senders must not emit a raw newline inside the JSON text (JSON escapes it).
  Receivers ignore empty and whitespace-only lines, and accept a trailing `\r` as whitespace.
- **WebSocket** (`DaemonServer.accept`, ALPD §61): one JSON-RPC message per text message, no newline
  framing. The same rules apply from §3 on. At this commit no shipped transport calls `accept`; it is
  specified for the remote gateway (Task 08).
- **In-process** (`DaemonServer.local`): JavaScript values, no handshake; not part of the wire contract.

**Frame limit.** `MAX_FRAME` = 16 MiB (16 777 216 bytes), counting the UTF-8 JSON text and its newline.
A message on a transport without newlines obeys the same limit, as if it had one (its JSON text is at
most `MAX_FRAME - 1` bytes).
- A client frame over the limit makes alpd close the connection without answering, since nothing after
  it can be trusted to align. Frames are measured one by one: several frames in one write may together
  exceed the limit.
- A message over the limit arriving on another transport fails with `-32600 frame_too_large`.
- A response that would exceed the limit is replaced by `1000` with `data.reason: "response_too_large"`.
- Large stable timeline events become bounded warning notices retaining their cursor (§8.7); other producers keep their events within the transport limit.

**Encoding.** Senders send valid UTF-8 and no lone surrogate escapes (`"\ud800"`): JavaScript accepts
them, Rust's serde_json does not. Invalid UTF-8 bytes received by alpd become U+FFFD. Object keys are
unique; a receiver's behaviour on duplicates is undefined.

## 5. Errors

### 5.1 Codes

| Code | Name | Meaning |
|---|---|---|
| -32700 | parseError | A frame is not JSON. Answered with `id: null`; the connection stays open. |
| -32600 | invalidRequest | Not a JSON-RPC 2.0 request object, a batch, an unusable id, a non-string method, an oversized message. |
| -32601 | methodNotFound | No such method (built-in or registered extension). |
| -32602 | invalidParams | `params` not an object, or not matching the method's schema; also handler refusals of bad input. |
| 1000 | failed | The method could not do its work (runtime refusals, persistence failures, timeouts). |
| 1001 | notFound | No such session, question, registered method, project, task or library entry. |
| 1003 | forbidden | The daemon refuses to touch a resource: a symlink out of a project's `.alp` (`unsafe_path`). A gateway uses it for its own refusals (`grant`, `outside_workspace`, `spec_field`, ...). |
| 1004 | conflict | A conflict with existing state: duplicate registration, prompt `key_conflict` or `outcome_unknown`, a stale `revision`, a task state that refuses the change. |
| 1005 | unavailable | Try again later: a lock another writer holds (`busy`). |
| 1006 | protocol | Handshake problems: `hello_required`, `protocol_version`; also unsafe extension names. |

`1002` is reserved. `1003` and `1005` came with the project, task and library methods (§15); an older client
that does not know them treats them as `failed`.
Clients treat any unknown code as `failed`. `error.message` is for people: never match on it.

### 5.2 Order of checks

For each incoming frame alpd applies these checks in order and stops at the first failure; **nothing
runs before all of them pass**:

1. not JSON → `-32700`;
2. a batch, or not an object with `jsonrpc: "2.0"` → `-32600`;
3. no `method` → a response to `extension.invoke` (§3);
4. over the frame limit → `-32600`;
5. `method` not a string → `-32600`;
6. no `id` → dropped (notification);
7. unusable `id` → `-32600` with `id: null`;
8. `params` present but not an object → `-32602`;
9. `daemon.hello` → its own checks (§6);
10. no handshake yet → `1006 hello_required`;
11. unknown method → `-32601`;
12. a built-in method whose params fail its schema → `-32602 invalid_params`;
13. the method's own refusals and failures.

### 5.3 `error.data`

`data` is optional and, when present, an object. `data.reason` is a stable machine-readable string:

| reason | code | Set by |
|---|---|---|
| `hello_required` | 1006 | any method before `daemon.hello` |
| `protocol_version` | 1006 | `daemon.hello`; `data.supported: number[]` lists the versions the daemon speaks |
| `invalid_params` | -32602 | non-object params or schema check; only schema failures include `data.issues: [{ path, message }]` (JSON Pointer paths) |
| `invalid_id` | -32600 | any id outside the safe-integer or ≤128-code-point string forms in §3 |
| `batch_unsupported` | -32600 | a batch |
| `frame_too_large` | -32600 | an oversized message on a message transport |
| `response_too_large` | 1000 | a result over the frame limit |
| `persistence_failed` | 1000 | `session.create`, `session.prompt`, `session.rename`, `session.archive` when the store cannot write |
| `outcome_unknown` | 1004 | `session.prompt`: the daemon cannot tell whether the provider received the prompt (§10) |
| `key_conflict` | 1004 | `session.prompt`: the `clientMessageId` was used with other content; `task.create`: the `requestId` was used for another task |
| `invalid_path` | -32602 | `projectRoot` is not an absolute, normalized path (§15.1, §12.3); a `workspace.files` `path` that is not plainly relative (§12.4) |
| `invalid_scope` | -32602 | a library `scope` the entry cannot live in: `project` without `projectRoot`, providers outside the library |
| `invalid_entry` | -32602 | library content core refuses: unknown fields, a bad MCP server, hook, provider or team, a name it refers to that does not exist |
| `secret_marker` | -32602 | `library.save`: a `{ "$secret": "keep" }` marker with no stored value to keep, or outside a secret map (§15.3) |
| `not_alp_project` | 1001 | `projectRoot` is not a directory holding `.alp/` |
| `unknown_task` | 1001 | no task of that id in the project |
| `not_found` | 1001 | no library entry of that kind and name (in that scope) |
| `not_directory` | 1001 | `workspace.files.search`, `workspace.files.list`, `workspace.files.read`: `projectRoot` is not a directory alpd can read (§12.3, §12.4) |
| `blocked_path` | 1003 | `workspace.files.list`/`read`: the path is on the block list (`.git`, `.env*`, ALP configuration, key and credential files), whatever the caller (§12.4) |
| `ignored` | 1003 | `workspace.files.list`/`read`: the path is `.gitignore`'d and `includeIgnored` was not set (§12.4) |
| `linked` | 1003 | `workspace.files.list`/`read`: a symbolic link on the way or at the end, a file with more than one name (hard link), a real path other than the one asked for, or a file or directory that changed while it was read (§12.4) |
| `binary` | 1000 | `workspace.files.read`: the file is not UTF-8 text (§12.4) |
| `too_large` | 1000 | `workspace.files.read`: the file is over 1 MiB (§12.4) |
| `unsafe_path` | 1003 | a symlink where a project's `.alp`, its tasks or a library entry would be read or written |
| `revision_conflict` | 1004 | a library `revision` or task `ifRev` that is no longer current; an entry that already exists where a new one was asked |
| `task_state` | 1004 | the task's state refuses the change: already closed or open, open children, a closed parent, a gate already clear or missing |
| `in_use` | 1004 | a library entry others refer to cannot be renamed or removed |
| `busy` | 1005 | the project's task lock stayed held by another writer for 5 s (an `alp` command, a backup) |
| `unreadable` | 1000 | the daemon user's `settings.json` or `role-skills.json` is not valid |

Errors thrown by an extension's owner travel unchanged (`code`, `message`, `data`). Errors inside
events (`session.failed`, `prompt.failed`, `turn.ended`) are `AlpError { message, code? }` with string
codes such as `outcome_unknown` and `daemon_restarted`.

## 6. Handshake and capabilities

### 6.1 `daemon.hello`

The first request on every connection:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "daemon.hello",
  "params": { "protocolVersion": 1, "client": { "name": "paseo", "version": "0.10.0" } } }
```

- `protocolVersion` other than `1` (or missing) → `1006` with `data: { reason: "protocol_version",
  supported: [1] }`. The connection stays open: the client may say hello again or close.
- Otherwise invalid params (e.g. `client` not an object) → `-32602`; the handshake has not happened.
- Success: `{ protocolVersion: 1, daemonVersion, pid, hostname, capabilities: string[] }`. `daemon.hello` may be
  repeated and answers the same.
- `hostname` (optional string) is the daemon host's machine name (`os.hostname()`), a label for clients (Paseo names
  a host by it). It is not an identity and grants nothing. The remote gateway passes it on after its own checks and
  never passes `pid` (docs/alp/remote-gateway.md §3). A daemon without it is valid; clients fall back to an address.
- `params.capabilities` (optional string array, a sibling of `client`) is reserved for client capabilities; v1 daemons ignore it.

### 6.2 Capabilities

A daemon lists only what it serves on that connection now. A client uses a feature only when listed;
a missing `capabilities` (alpd before this revision) means none. Unknown names are ignored.

| Capability | Meaning |
|---|---|
| `session.history` | Durable backward pages and a generation precondition on attach (§8.7). |
| `attach.after` | `session.attach` accepts `after` and answers `cursor` and `reset`; kept envelopes carry `cursor` (§8). |
| `prompt.receipts` | `session.prompt` is answered from durable receipts (§10). Listed only when alpd has a store. |
| `extension.methods` | `extension.register` / `extension.unregister` and `extension.invoke` (§3). |
| `schedule` | `schedule.create/list/get/cancel`: one-shot root continuations; only with a store and home (ALPD §71). |
| `task` | `task.list`, `task.create`, `task.update`, `task.gate.resolve` (§15.2). Every alpd lists it. |
| `team` | `team.list` (§15.4). Listed when alpd serves its user's home (alpd always does; an embedded server only when given `home`). |
| `library` | `library.list/get/save/delete/duplicate/rename`, `library.skills.set`, `library.models` (§15.3). Same condition as `team`. |
| `settings.language` | `settings.language.get/set` (§15.5). Same condition as `team`. |
| `session.list.page` | `session.list` accepts `limit`, `cursor` and `query` and answers `nextCursor` (§12.1). Every alpd lists it. |
| `question.watch` | `question.watch`: questions of trees the connection is not attached to (§12.2). Every alpd lists it. |
| `question.watch.turns` | `question.watch` accepts `turns`: also every root's `turn.ended` (§12.2). Every alpd lists it. |
| `session.attention` | `question.watch` accepts `attention`: each root's finished or error attention, kept by alpd for every client, in the answer and as `attention` events; `session.attention.clear` acknowledges one (§12.2). Every alpd lists it. |
| `workspace.files` | `workspace.files.search`: file names under a directory matching a query, read-only (§12.3). Every alpd lists it. |
| `workspace.files.read` | `workspace.files.list` and `workspace.files.read`: a directory's entries and a UTF-8 text file's content (at most 1 MiB) under a directory, read-only, links never followed, blocked paths refused (§12.4). Every alpd lists it. |
| `prompt.images` | `session.prompt` takes inline image parts (§10, Prompt content); a session snapshot's `promptImages: true` says its runtime takes them. Every alpd lists it. |

alpd before this revision already had the first three without listing them; the others are new. A method whose
capability a daemon does not list answers `-32601`. A client that must work with
both may probe (e.g. send `session.attach` with `after` and look for `cursor` in the result), but should
prefer capabilities and treat their absence as "not available".

### 6.3 Incompatible versions

`PROTOCOL_VERSION` changes only for a change existing clients cannot ignore: removing or renaming a
method, param or result property, changing a type or meaning, or a new required param. Adding methods,
optional params, result properties, event types, item kinds, error reasons and capabilities is
compatible and needs no version change. A future daemon that speaks several versions lists them in
`data.supported`; a client picks the highest it knows and says hello again.

## 7. JSON values

- **Unknown properties** in params, results, events and items are ignored by receivers (forward
  compatibility). alpd does not reject unknown params properties.
- **Missing versus null.** An optional property is omitted when absent. `null` is a value: where the
  schema does not allow `null`, sending it is invalid (`-32602` for params). Senders never use `null`
  to mean "absent" or "default". In-process callers' `undefined` counts as absent.
- **Unknown event types and item kinds** are ignored by clients (the schema accepts them; the
  TypeScript unions are closed on purpose, so clients need a default branch).
- **Numbers.** Integers stay within ±(2^53-1) so that JavaScript and Rust agree; `seq`, `cursor` and
  ids are integers in that range. Durations such as `idleMs` are numbers of milliseconds.
- **Strings and lengths.** Strings are Unicode; schema-declared length limits count code points,
  e.g. `session.rename` `title` 1–200 code points with at least one non-whitespace character.
  Existing runtime limits on `session.message`, `question.answer` and `assignment.recall` count
  UTF-16 code units; their refusals may return `1000`.
- **Timestamps** are ISO 8601 UTC strings with milliseconds and `Z`
  (`2026-10-15T07:43:02.845Z`), as `Date.prototype.toISOString` writes them. Receivers order by parsing
  them, not by comparing strings across sources.
- **Paths** are absolute paths on the daemon's host and are informational for remote clients.

## 8. Events, envelopes and replay

### 8.1 Envelope

The daemon sends `{ "jsonrpc": "2.0", "method": "event", "params": Envelope }` to every connection
attached to the event's tree (§9), and a tree's `question` / `question.resolved` (and its root's
`turn.ended`, to those that asked for `turns`) also to the connections watching questions (§12.2):

```ts
{ sessionId: string; epoch: string; seq: number; cursor?: number; ts: string; event: AlpEvent }
```

- **epoch**: random per runtime instance; a new alpd process or runtime has a new epoch.
- **seq**: ordinary runtime events increase per session within an epoch, starting at 1. It is
  informative ordering, not a replay position or deduplication key. Synthetic envelopes (below)
  reuse a seq or use 0. Restart reconciliation also keeps envelopes with `seq: 0` under a
  `restart-…` epoch; several kept envelopes may share that epoch and seq.
- **cursor**: the envelope's position in its **tree's** stored timeline, strictly increasing per root
  across restarts, starting at 1. Only envelopes with a `cursor` are part of the timeline ("kept").
- **Synthetic envelopes** without `cursor`: the re-announcement of a live tree when a client reopens a
  root (`session.opened`, `session.ready`, `turn.started` of a running turn), pending `question`s
  announced on attach, the `question` / `question.resolved` / `turn.ended` copies `question.watch` sends,
  and its `attention` events, which are never kept (§12.2). A client never advances its cursor from an envelope without one.
- **History digests**: when resuming a closed root, `session.create { history: "replay" }` sends the
  root's latest version of each timeline item and its children's events. For an already-live root
  (`attached: true`), it sends root items and synthetic announcements of live children, without
  closed children's history. Kept envelopes retain their cursors, but this is a digest, not a
  cursor-ordered replay: a cursor-tracking client uses `history: "skip"` and then
  `session.attach { after }`.
- **Session names**: alpd keeps a kept `session.updated` (epoch `title-…`, `seq: 0`) for a live root
  whose name is set, its `session` carrying `title`. The first user message of an unnamed root names it,
  as Paseo names an agent: its first non-blank line, whitespace folded, at most 60 code points, no
  ellipsis. Only the user's words do: a `user_message` says who wrote it in `origin` (`user`, or ALP
  itself: `wake`, `assignment`, `runtime`); one ALP sent itself (`origin` other than `user`, or a
  `clientMessageId` `alp-…`) never names a root, nor does one without `origin` or `clientMessageId`,
  which nobody can place. A message replayed from a resumed thread's native history carries the
  `clientMessageId` ALP sent it under (Codex keeps it as the item's `clientId`) and only the prompt
  ALP built the input around, never ALP's context parts (catalog, task digest, mail); one from a
  thread started outside ALP is `user`. The announcement follows the
  `item` of that message. `session.rename` is announced the same way. Runtime `session.updated` events
  carry no `title`; a client keeps the last one it saw. `session.get` / `session.list` give the same
  `title`.

### 8.2 Ordering

For one `session.attach` replay and the live events that follow it, kept envelopes of a tree arrive
in cursor order, without gaps except the filtering below, and without duplicates within that attach.
A repeated attach may replay envelopes already delivered; history digests (§8.1) have different ordering. Envelopes of different trees interleave.
Events and responses interleave: an event caused by a request may arrive before or after its response.

### 8.3 `session.attach` and the replay cursor

`session.attach { sessionId, replay = true, after? }` (capability `attach.after`) attaches the
connection to the session's tree and answers `{ session, cursor, reset? }`:

- `cursor` is the tree's tip at the moment of attaching: the highest cursor the daemon has assigned.
- With `replay`, kept envelopes with `cursor > after` (all, without `after`) are sent before the
  response, in cursor order. `question` and `question.resolved` events are not replayed; the questions
  still waiting are announced afresh (synthetic).
- **Race-free hand-over**: alpd sends the replay and registers the connection for live events with no
  await between them, so every kept envelope after the replay has a higher cursor and none is missed
  or repeated. Another implementation must give the same guarantee.
- **reset**: when the daemon cannot continue from `after` (a cursor beyond the tip, as from another
  timeline, or one whose successor is no longer kept), the result has `reset: true` and the replay
  starts at the earliest kept envelope. The client discards its projection of that tree and rebuilds it.
- With `replay: false`, no historical events are sent and missing-history gaps are not checked;
  a cursor beyond the tip may still set `reset: true`. Waiting questions are still announced.
  This mode subscribes to future events; it cannot rebuild a projection.
- With alpd's store, a tree's timeline is never trimmed while the tree exists (ALPD §68), so only a
  cursor beyond the tip resets. Without a store, at most the latest 20 000 envelopes per live tree
  are kept in memory; closing a tree discards that log. A reset may therefore have no history to replay.

**Expired trees.** Retention removes a tree, records and timeline, after 30 days without activity
(and no receipt in its window, nothing live, attached or recovering). There is no tombstone: attaching
to it fails with `1001` exactly as for an id that never existed. Clients drop their cache for it and
do not recreate it.

**Client algorithm.** Keep the last cursor per root. On reconnect: hello, then
`session.attach { sessionId: root, after: last }`. Buffer that root's events while attach is pending:
replay arrives **before** the response carrying `reset`. Once the response arrives, clear the root's projection and saved cursor if `reset: true`, then apply the buffered events in order and continue
with live events. Advance the cursor from kept envelopes only. If reset has no retained history,
use the returned session summary and show the history as unavailable; it cannot recover lost events.

### 8.4 Terminal events

Per turn, `turn.ended` with `state` `completed`, `failed` or `canceled` ends `turn.started`.
`session.failed` may be followed by `session.closed`. A normal close ends that live incarnation;
the retained root may later resume under the same id and emit more events. Crash reconciliation
may close a root record without a terminal session event, adding only `turn.ended` when needed.
Clients also consult session summaries. Closed roots stay attachable while their records are retained.

### 8.5 Session usage

`{ type: "usage", usage: SessionUsage }` says a session's usage changed, as Paseo's `usage_updated`
(packages/protocol/src/agent-types.ts `AgentUsage` at b63a325). It carries the whole latest
`SessionUsage`, not a delta, and is kept in the tree's timeline like any runtime event, so a replay
restores it. The session snapshot (`session.opened` / `session.updated`, `session.get`,
`session.list`) has the same object as `usage` once the runtime has reported; a closed session keeps
the last one.

```ts
SessionUsage = {
  contextWindowUsedTokens?: number; // integer ≥ 0: what the context holds now (the latest model call's input and output)
  contextWindowMaxTokens?: number;  // integer ≥ 1: the window, once the runtime has said it
  inputTokens?: number;             // integer ≥ 0: the latest model response's input (ACP: the latest turn's)
  cachedInputTokens?: number;       // integer ≥ 0: of which read from cache
  outputTokens?: number;            // integer ≥ 0
  totalCostUsd?: number;            // ≥ 0: the session's cost so far, as the runtime counts it
}
```

Every field is optional: a runtime reports what it knows, and a later report replaces the fields it
carries and keeps the others, except that `inputTokens`, `cachedInputTokens` and `outputTokens` are
replaced together (a report with any of them drops those it lacks). alpd sends the event only when the usage changed. What each runtime
reports (ALPD §57): Codex `thread/tokenUsage/updated` (context, window, tokens; no cost); Claude each
main-thread assistant message's usage (context, tokens), the window once `getContextUsage` or a
result names it, and each result's `total_cost_usd` (counted by the Claude process, so it restarts
when the process does); an ACP agent's `usage_update` (context, window, `cost` in USD only) and the
prompt response's unstable `usage` (tokens); Antigravity its steps' tokens. No secret, path or
account data is in it. Account-wide usage (plan windows) is `daemon.usage`, which is local only.

### 8.6 Tool-call details

A `tool_call` item (`{ kind: "tool_call", id, callId, name, status: "running" | "completed" | "failed",
error?, detail }`) says what the call did in `detail`, typed by kind in the shapes of Paseo's
`ToolCallDetail` (packages/server/src/server/agent/agent-sdk-types.ts at b63a325). The schema's
`$defs/toolCallDetail` is normative; fields are optional unless named:

```ts
ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | { type: "search"; query: string; toolName?: "search" | "grep" | "glob" | "web_search"; content?: string;
      filePaths?: string[]; webResults?: { title: string; url: string }[]; numFiles?: number;
      numMatches?: number; truncated?: boolean }
  | { type: "fetch"; url: string; prompt?: string; result?: string; code?: number }
  | { type: "sub_agent"; subAgentType?: string; description?: string; log?: string }
  | { type: "plan"; text: string }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "unknown"; input: unknown; output: unknown }
```

- **Name.** `name` is the native tool's name: Claude's `Read`, `Edit`, `Grep`, `Task`, `mcp__server__tool`…;
  Codex `apply_patch` (a file change), `web_search`, `mcp__<server>__<tool>`, `Sub-agent`; an ACP agent's
  call title, else its kind; Antigravity's tool name. A command is `shell`; ALP's own tools
  (`alp_*`) are `unknown` with their input and output.
- **What each runtime types** (ALPD §4.2): Claude's Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob,
  WebFetch, WebSearch, Task/Agent (`sub_agent`), ExitPlanMode (`plan`), Skill and TodoWrite (`plain_text`);
  an ACP call by its kind (read, edit, delete, move, search, fetch, think; execute is `shell`); Antigravity's
  run_command (`shell`), view_file, write_to_file, replace_file_content and multi_replace_file_content;
  Codex's fileChange, webSearch, mcpToolCall and collabAgentToolCall items. Any other tool is `unknown`.
  A running item already carries what the runtime has said, such as a Read's path.
- **Paths.** `filePath` and `filePaths` are what the runtime reported, often absolute paths on the
  daemon's host, possibly outside the workspace; a viewer shows them relative to the session's working
  directory when inside it. No file is read to fill a detail: contents and diffs are what the tool
  itself returned or was given.
- **Bounds.** The runtime clips each string field of a typed detail (not `shell`, not `unknown`) to 65,536
  UTF-16 code units, keeping the head and appending `\n… (N more characters)`; `filePaths` to 200 entries
  (then `truncated: true`) and `webResults` to 50. `shell` and `unknown` details are as they were. The
  schema states no length limits for them.
- **Errors.** A failed typed call carries `error`, the tool's own error text clipped to 2,000 code units, or
  `"Tool call failed"`; a failed command `"Command failed"` as before.
- **Forward compatibility.** Later revisions of v1 may add detail types. The schema accepts a detail whose
  `type` is any other string (as it accepts unknown item kinds); a receiver shows it as `unknown`: the
  item's name and the detail's `input` / `output` when present. The TypeScript union is closed, so
  receivers need a default branch.

### 8.7 Durable backward history

With `session.history`, `session.history { sessionId, before?, limit?, maxBytes? }`
returns `{ generation, items, olderCursor?, hasOlder, tipCursor }`. `items` are source
**envelopes in ascending cursor order**, including updates of the same item. Clients
merge by stable item ID; newer snapshots win. This is distinct from session-list paging.
Default limit is 200, maximum 500. The response is at most 512 KiB (including reserved
response overhead); `maxBytes` may reduce that budget. The gateway supplies a host-selected
budget below its frame limit, ignoring a remote client's budget. All reads require
`session.read` and the gateway authorizes the requested session before forwarding a cursor.
Each returned envelope is confined to the same authorized tree and uses normal event redaction.

`olderCursor` is an opaque signed token bound to the requested session, persisted history
generation, exclusive source position and original upper watermark. Pass it unchanged as
`before`; do not derive it from item IDs or timestamps. The watermark stays fixed when new
events append. Invalid, modified and cross-session cursors fail with `-32602` /
`invalid_cursor`; a replaced generation fails with `1004` / `stale_cursor`. No history is
silently reset. Generations and cursor authentication survive normal daemon restarts.

`tipCursor` is a **numeric forward attach watermark**, not the opaque backward token. It is
the last source position covered by the initial tail, including oversized markers (0 for
an empty history). Buffer events, fetch the initial history page, then send
`session.attach { sessionId, after: tipCursor, generation }`, including `after: 0` for an
empty page. Attach checks generation before the final synchronous replay/subscription
handoff. On `stale_cursor`, discard the cached history and fetch a fresh tail. An append
burst that overruns replay coverage during an asynchronous read explicitly fails with
`1005` / `history_gap`; retry attach from the same checkpoint. Legacy attaches without
`generation` retain their existing shapes and behavior. Reconnect using the last applied
numeric cursor and the cached generation; do not resend prompts.

An envelope too large for one page is represented by
`{ cursor, oversized: { bytes } }`. It consumes its source position so paging progresses,
but its content is unavailable; clients display an explicit warning. Large stable replay
and live events likewise become small warning notices with their original cursor, rather
than breaking the connection or silently disappearing. The gateway further reduces these
notices for its transport frame limit. This does not provide a separate large-event fetch.

Storage uses a derived fixed-width seek index (offset, byte length, stable cursor) and private
persisted metadata. After migration, each page seeks at most `limit` index records and reads
at most its byte budget of source data. First use, or recovery from missing/truncated index
or corrupt metadata, scans the source once, one complete JSONL line at a time; a pathological
single historical line can therefore require memory proportional to that line. Rebuilding
a damaged index rotates generation and explicitly invalidates old cursors. New appends are
indexed incrementally. Removing a tree also removes its index/metadata. This has the same
process-crash durability guarantee as the existing store, without an fsync/power-loss promise.

The web app fetches a bounded tail, offers **Load older messages**, preserves the first visible
stable row's screen position when prepending, and retains loaded pages across reconnects.
The Paseo bridge lazily fetches older source pages and rebuilds their projected turn/tool
fragments at stable source positions. Virtualization of already-loaded web rows is separate.


## 9. Connections, attachment and lifecycle

- `session.create` and `session.attach` attach the calling connection to the root's tree; events of the
  whole tree (root, children, supervisor) are delivered to it.
- `session.release` detaches the connection and answers `closed: true` when the root, idle and watched
  by nobody, was closed.
- **Disconnect** detaches every root the connection watched. A root that is idle and unwatched is
  closed; a busy root keeps working with no viewer and is closed when it becomes idle. Extension
  methods the connection registered are removed; its pending `extension.invoke` calls and calls it
  made to other owners fail with `1000`.
- `session.close` closes a live session now. `session.archive` closes a root with its tree and hides it
  from lists until unarchived. Neither deletes data.

## 10. Cancellation, timeouts and idempotency

- **No request cancellation.** v1 has no `$/cancelRequest`. A client that stops waiting (a timeout, a
  closed connection) does not stop the operation: it may complete after the client gave up.
- **Turn cancellation** is `session.interrupt { sessionId }`: it cancels the session's work. The running
  turn ends with `turn.ended { state: "canceled" }`, and the session's child sessions are closed (an
  idle requester waiting on its assignments ends that wait). The response may arrive before or after
  the `turn.ended` event.
- **Server-side timeouts**: `extension.invoke` times out after 30 s (`1000 "<method> timed out"`);
  the owner's work may continue. `assignment.recall` times out after 300 s. Provider transports
  also impose request deadlines (normally 30 s), so methods such as create, configure and interrupt
  may fail with `1000`. There is no single JSON-RPC-wide deadline.
- **Prompt idempotency** (capability `prompt.receipts`): `session.prompt` is delivered at most once per
  `(sessionId, clientMessageId)`.
  - The first delivery answers `{ outcome: "accepted" | "failed", error?, durable }`; `failed` means the
    runtime refused it (the reason is in `error`), not a transport error.
  - A repeat with the same `delivery` and `content` answers the first outcome with `duplicate: true`
    and starts nothing; concurrent repeats wait for the first.
  - A repeat with other content fails `1004 key_conflict`.
  - When alpd cannot know whether the provider received the prompt (a crash between sending and
    recording, or a provider failure mid-request) it fails `1004 outcome_unknown` now and on every
    repeat. The client checks the timeline and sends again with a **new** id if needed.
  - `durable: false` means the outcome is known to this alpd process but not yet on disk.
  - Durable receipts are eligible for removal after 7 days from their last write. Cleanup runs on
    startup and normally every 6 hours, so an older receipt may still answer duplicates until
    cleanup succeeds. Unsaved outcomes held in memory remain for the process lifetime. Once a
    receipt is removed, the same id can deliver a new prompt; clients should not reuse ids.
  - A request refused before a receipt (invalid params, unknown session) records nothing.
  - This guards against duplicate delivery to the provider, not duplicate effects: ALP never promises
    exactly-once for tools or other external side effects of a turn.
- Without `prompt.receipts` (alpd without a store) `session.prompt` answers `{}` and is not
  idempotent.
- **Prompt content** (capability `prompt.images`, t-7679.11): `content` is an array of parts.
  - `{ type: "text", text }` is the user's words; the text parts are joined with newlines.
  - `{ type: "image", mimeType, data, name? }` is an image **inline**: `mimeType` is `image/png`,
    `image/jpeg`, `image/gif` or `image/webp`, `data` is its base64 (`PROMPT_IMAGES` in
    `@anhlp/alp-protocol`: at most 8 images, each at most 5 MiB decoded and 11 MiB together, so their
    base64 fits one `MAX_FRAME`), `name` at most 255
    characters, and no other field: the schema refuses `path`, `url` or anything else, so a
    prompt can never name a file on the host. Over the limits it fails `-32602`.
  - alpd hands images to the runtime as data URLs it builds (`{ type: "image", url: "data:…" }` in
    the Codex turn input); Claude gets base64 image blocks, an ACP agent ACP image blocks when its
    `initialize` offered `promptCapabilities.image`. Antigravity, and an ACP agent that did not
    offer it, take none: the session snapshot has no `promptImages`, and a prompt with an image
    answers `prompt.failed` ("… takes no images") before anything is sent. Any other part type
    (such as Codex's `localImage` with a path) fails the same way.
  - The `user_message` item of such a prompt carries `images: <count>`; image data is never put in
    events, the timeline or the run log, so a replay shows the count, not the image.
  - The receipt's fingerprint covers the images: a repeat with another image is `key_conflict`.
- **`task.create` with `requestId`** is answered once per `(projectRoot, requestId)` for 10 minutes **within one alpd
  process**: a repeat with the same title and priority answers the first `{ id }` with `duplicate: true`, concurrent repeats
  wait for the first, other content fails `1004 key_conflict`, and a create that failed may be tried again. Nothing is
  kept on disk: after an alpd restart, or a `1000`, read `task.list` before creating again.
- **Library saves** are guarded by `revision` (§15.3): a repeat of a save that succeeded fails `revision_conflict`.
- **Other methods are not idempotent** unless the table in §12 says so; a client that retries after a
  lost response must first read state (`session.get`, `session.list`).

## 11. Conformance suite

`packages/protocol/conformance/run.mjs` checks an implementation from outside, over its stream endpoint.
It imports no implementation code, only `node:net` and the protocol's schemas.

```sh
node packages/protocol/conformance/run.mjs --socket /path/to/alpd.sock                       # handshake, wire, errors, limits
node packages/protocol/conformance/run.mjs --socket S --profiles handshake,wire,errors,limits,session \
  --project /tmp/project --model codex:gpt-5.6-sol --hold-marker '[hold]' --json
```

- **Profiles**: `handshake`, `wire`, `errors`, `limits` are declarative cases in
  `conformance/cases.json` (each on a fresh connection; side-effect checks re-register an extension
  method a refused frame would have registered). `session` runs scenarios in `run.mjs`: lifecycle,
  replay after a cursor, reset, live events after replay, prompt idempotency, no effect of an invalid
  prompt, interrupt, Unicode and code-point limits, release and close.
- **Every frame** the daemon sends is validated against the schema, and every result against its
  method's result schema.
- **Session profile requirements**: a disposable daemon home and an initialised ALP project in
  `--project` with its supervisor disabled; a provider whose turns end by themselves, except that a prompt containing the hold marker
  keeps its turn running until interrupted. alpd's tests use `packages/daemon/tests/support/fake-codex.js`
  via `ALP_CODEX_BIN`; `packages/daemon/tests/conformance.test.js` runs every profile against a real
  alpd process this way.
- **Golden fixtures** `fixtures/v1/cases.json` (183 values): an implementation's own unit tests should
  load them and check that its decoder accepts every valid value and its validation rejects every
  invalid one. `projection: false` marks values the closed TypeScript unions leave out on purpose.

**Running it against a Rust implementation**: build the daemon, start it with a temporary home and a
fake provider meeting the requirements above, wait until its socket accepts connections, run the runner
with `--socket` and `--json`, and fail the build on any `"ok": false`. Results that were skipped carry a
`note`. **No Rust implementation has been run against this suite yet**; passing it is the definition of
wire compatibility, so do not claim compatibility before it passes.

## 12. Method reference

Params and results are in `methods-v1.json`; this table adds what a schema cannot say. "Scope" is the
**proposed** grant for future remote access (Task 09A); v1 does not enforce it, and every
connection on the local socket acts as the owner.

| Method | Effect | Idempotent | Notable errors | Proposed scope |
|---|---|---|---|---|
| `daemon.hello` | handshake | yes | 1006 | — |
| `daemon.status` | read | yes | — | session.read (`pid` hidden remotely) |
| `daemon.shutdown` | stops alpd after answering | yes | — | host.admin |
| `daemon.pause` / `daemon.resume` | pause state, notices | yes (same state) | -32602 | host.admin |
| `daemon.pauses` | read | yes | — | host.admin |
| `daemon.usage` | read; `refresh` probes providers | yes | — | session.read |
| `catalog.get` | read | yes | — | session.read |
| `assignment.recall` | asks a finished assignment's thread (a model call) | no | 1000, -32602 | session.write |
| `board.list` | read | yes | -32602 | session.read |
| `question.list` | read | yes | — | session.read |
| `question.watch` | read, then question events of every tree, roots' turn ends with `turns`, roots' attention with `attention` (§12.2) | yes (a second call replaces the filter) | -32602 | session.read |
| `session.attention.clear` | acknowledges a root's attention for every client; told as an `attention` event (§12.2) | yes (a second call answers `cleared: false`) | -32602, 1001, `persistence_failed` | session.read (a look is a read) |
| `workspace.files.search` | read: file names under `projectRoot` (§12.3) | yes | -32602, 1001 | project.read |
| `workspace.files.list` / `workspace.files.read` | read: a directory's entries; a text file's content (§12.4) | yes | -32602, 1000, 1001, 1003 | files.read (never a default; docs/alp/remote-gateway.md §5.10) |
| `question.answer` | answers or dismisses; a unique id prefix is accepted | no (second answer → 1001) | 1001, -32602 | session.write |
| `session.create` | creates or resumes a root, attaches | no (an existing live root is attached: `attached: true`) | -32602, 1000, 1001, `persistence_failed` | session.write |
| `session.preview` | read (no files written) | yes | -32602, 1000 | session.read |
| `session.attach` | attaches; replays | yes | 1001, -32602 | session.read |
| `session.release` | detaches; may close an idle root | yes | — | session.read |
| `session.prompt` | starts or steers a turn | with receipts (§10) | 1001, 1004, `persistence_failed` | session.write |
| `session.interrupt` | cancels the running turn, closes child sessions | yes | 1001 | session.write |
| `session.configure` | changes mode | yes (same mode) | 1000, 1001 | session.write |
| `session.close` | closes | no (second → 1001) | 1001 | session.write |
| `session.rename` | renames a root; announced as `session.updated` (§8.1) | yes | -32602, 1001, `persistence_failed` | session.write |
| `session.archive` | archives/unarchives a root, closes it | yes | -32602, 1001, `persistence_failed` | session.write |
| `session.get` / `session.list` | read; `session.list` pages (§12.1) | yes | 1001; -32602 for a cursor alpd did not give | session.read |
| `session.status` | read (live tree) | yes | 1001 | session.read |
| `session.message` | posts user mail to a session | no | 1000, 1001 | session.write |
| `session.log` | read | yes | — | session.read |
| `extension.register` / `extension.unregister` | per-connection method table | no (second → 1004/1001) | 1004, 1006, 1001 | host.admin |
| `team.list` | read: built-in, library and project teams | yes | -32602, 1001, 1003 | project read (+ host library) |
| `task.list` | read `<projectRoot>/.alp/tasks` | yes | -32602, 1001, 1003 | project read |
| `task.create` | writes a task under the task lock | with `requestId`, per alpd process (§10) | -32602, 1001, 1003, 1004 `key_conflict`, 1005 | project write |
| `task.update` | closes or reopens a task | no (second → 1004 `task_state`); `ifRev` guards | 1001, 1003, 1004, 1005 | project write |
| `task.gate.resolve` | approves a gate (a human step closes its task) | no (second → 1004 `task_state`); `ifRev` guards | 1001, 1003, 1004, 1005 | project write |
| `library.list` / `library.get` | read, secrets redacted | yes | -32602, 1001, 1003 | project read + host library read (the remote gateway: `project.read` with a granted `projectRoot`; `library.get` content redacted further, docs/alp/remote-gateway.md §5.7) |
| `library.save` | writes an entry; `sync` writes projects' settings | with `revision` | -32602, 1001, 1003, 1004 | host library or project write; **code-execution config** for mcp, hooks, providers |
| `library.delete` / `duplicate` / `rename` | writes | no | -32602, 1001, 1003, 1004 | as `library.save` |
| `library.skills.set` | writes `role-skills.json` | yes (same list) | -32602 | host library write |
| `library.models` | read | yes | — | host read |
| `settings.language.get` / `set` | read / writes `settings.json` | yes | -32602, 1000 | host read / host write |

### 12.1 `session.list` pages and search

`session.list { projectRoot?, projectRoots?, rootsOnly?, includeClosed?, includeArchived?, limit?, cursor?, query? }`
(capability `session.list.page`) answers `{ sessions, nextCursor? }`, as Paseo's History reads a
host's agents (`fetch_agent_history`, Paseo `b63a325`):

- **Order**: roots before children, then the latest `updatedAt` first, then by `id`.
- **`limit`** (1–1000): at most that many sessions. `nextCursor` is present only when more follow;
  its absence is the end. Without `limit` every session is answered and there is no `nextCursor`,
  as before this revision.
- **`cursor`**: a `nextCursor` from an earlier answer with the same filters; the page continues after
  the session it names (a keyset, not an offset), so sessions created meanwhile do not shift it. A
  session whose `updatedAt` changes between pages moves in the order and may be seen twice or missed;
  a client that must be exact reads again from the start. Clients treat the cursor as opaque; one
  alpd cannot read answers `-32602`.
- **`query`** (at most 200 code points): sessions whose `title` or `id` holds every
  whitespace-separated word, case-insensitive, as a substring. Filters, then pages. Paseo also
  matches the project name and branch, with typo tolerance; ALP lists one workspace per view, so the
  title is what tells sessions apart.
- **`projectRoots`** (1–1024 strings): sessions of any of these projects, compared as strings like
  `projectRoot`; with `projectRoot` both apply. A gateway names its grant's workspaces with it.
- A daemon without the capability ignores these params and answers the whole list without
  `nextCursor`; a client hides server search there.
- **Through the gateway**: it sends `projectRoots` with the path and canonical path of each granted
  workspace (only the one `projectRoot` names, when given), reads alpd's pages on while the grant
  drops rows, and answers its own cursors. A grant with more than 1024 such strings is listed whole,
  unpaged, and searched by the gateway, as before this revision: alpd is then sent no `query`,
  `limit` or `cursor`. The cursors it answers are alpd's sealed with AES-256-GCM under a key of the gateway
  process, bound to the credential. A cursor it did not give that credential (another one's, alpd's
  own, or one from before a gateway restart) answers `-32602`; the client reads again from the start.

### 12.2 `question.watch`

`question.watch { projectRoot?, turns? }` (capability `question.watch`) answers `{ questions }`, the questions
waiting now (as `question.list` with the same `projectRoot`). From then on, for as long as the
connection lasts, alpd sends it every `question` and `question.resolved` event of every tree (of
`projectRoot` when given, compared as the string alpd records for the tree), attached or not:

- A connection attached to the tree gets the kept envelope only, once. Others get a synthetic copy
  without `cursor` (§8.1): it never advances a replay cursor.
- Registering and listing happen with no await between them: a question is in the answer or its
  event follows it. A second call replaces `projectRoot` and answers the list again.
- Events sent while a client was disconnected are not replayed. After reconnecting, a client calls
  `question.watch` again and takes its answer as the whole set of waiting questions.
- **`turns: true`** (capability `question.watch.turns`): the connection is also sent the `turn.ended`
  of every **root** session (the envelope's `sessionId` is the tree's root; a child's turn ends are
  not sent) of the watched trees, by the same rules: kept envelope once when attached, else a copy
  without `cursor`. This is the attention signal of Paseo's "Agent finished" / "Agent needs
  attention" (`agent_attention_required`, reasons `finished` and `error`, b63a325): a client reads
  `state` (`completed`, `failed`, `canceled`) and `error`. Turn ends are not listed in the answer and
  are not replayed after a reconnect. A second call without `turns` stops them. A daemon without the
  capability ignores `turns`.
- **`attention: true`** (capability `session.attention`): alpd keeps, on each root's record (persisted,
  so it survives a restart), the attention of its last turn, as Paseo keeps `requiresAttention` on its
  host: a turn that ends `completed` sets `{ reason: "finished", at, turnId }`, `failed` sets
  `{ reason: "error", at, turnId, message? }`, `canceled` clears it, as do the root's next
  `turn.started` and `session.archive` (an archived root never has one). The answer then also holds
  `attention: [{ sessionId, attention }]`, every root of the watched project that has one now, so a
  client that was disconnected or closed when a turn ended learns of it from its next
  `question.watch`; and the connection is sent an `attention` event (envelope `sessionId` = the root,
  no `cursor`, epoch `attention-…`, never kept, attached or not) each time one is set (`attention`)
  or cleared (no `attention`). `session.get` / `session.list` rows carry `attention` too. A second
  call without `attention` stops the events. A daemon without the capability ignores `attention`
  and answers no `attention`.
- **`session.attention.clear { sessionId, at? }`** (capability `session.attention`): the user looked at
  the root, so its attention is over for every client (Paseo's `clear_agent_attention`): alpd clears
  it, persists that without changing the root's `updatedAt`, tells the watchers, and answers
  `{ cleared: true }`; `{ cleared: false }` when it had none or, with `at`, when its attention is not
  the one set at `at` (a look at an older ending never hides a newer one). A session alpd does not
  know answers `1001`. When the write fails it answers `persistence_failed`, tells nobody, and the
  root keeps its attention unless a turn of the root started or ended, or the root was archived,
  while the write was on its way. apps/web acknowledges when the user opens, focuses or writes to
  the root, or when an ending arrives on the root in front of them; when the host refuses, the page
  shows the attention again and acknowledges it on the next look or watch read.

The gateway forwards it with no `projectRoot` (and `turns: true` when the client sent it), filters the
answer as `question.list`'s, and lets each event out only if its session's tree lies in the grant and,
when the client named a workspace, in that workspace or a tree the client attached
(docs/alp/remote-gateway.md §5.1).

### 12.3 `workspace.files.search`

`workspace.files.search { projectRoot, query?, limit? }` (capability `workspace.files`) answers
`{ files: [{ path }], truncated? }`: the files under `projectRoot` whose path matches `query`, best
first, as Paseo's command center finds a workspace's files (`directory_suggestions_request` with
`includeFiles`, server/utils/directory-suggestions.ts at b63a325):

- **`projectRoot`**: an absolute, normalized path (§15.1; else `-32602 invalid_path`) of a directory
  (else `1001 not_directory`). Unlike §15 it need not hold `.alp/`. Its real path is walked.
- **`path`**: relative to the walked directory, `/`-separated; files only.
- **Read-only, names only**: no file is opened. A symbolic link is never followed: neither listed nor
  entered, so nothing outside the directory is reached through one. Each directory is checked before
  and after it is read (a real directory, not a link, at the real path it was reached by, the same
  device and inode both times); otherwise what was read is dropped. **Residual risk**: a link swapped
  in and back out between those two checks, by a writer racing inside the directory, can expose the
  names (never the contents) of the directory it pointed to; Node offers no `openat`/`O_NOFOLLOW`
  walk that would close it.
- **Skipped**: names starting with `.` (files always; directories except `.agents`, `.alp`, `.claude`,
  `.codex`, `.github`, `.opencode`, `.paseo`, `.vscode`), and the directories `node_modules`, `venv`,
  `env`, `virtualenv`, `dist`, `build`, `target`, `out`, `coverage`, `vendor`, `__pycache__`, `.git`.
  `.gitignore` is not read (Paseo asks git; alpd runs no process for this).
- **Ranking** (Paseo's, simplified), case-insensitive: a path segment equal to `query`, then one that
  starts with it, then one that holds it; then the last segment holding its letters in order. With a
  `/` in `query` the whole path is matched. Ties: earlier segment, earlier offset, fewer gaps,
  shallower, then path. An empty `query` lists the shallowest files.
- **`limit`** 1–100 (default 30); `query` at most 200 code points.
- **Limits**: 12 directory levels, 20 000 entries looked at, 3 s, checked per entry (a directory is
  iterated, not read whole); the walk goes breadth first, and when it stops early the answer has
  `truncated: true`.

The gateway needs `project.read` and a `projectRoot` naming a granted workspace exactly, sends alpd
its canonical path, and drops any answered path that is not plainly relative (docs/alp/remote-gateway.md
§5.1). File contents are read by `workspace.files.read` (§12.4), with its own capability and permission.

### 12.4 `workspace.files.list` and `workspace.files.read`

Capability `workspace.files.read` (2026-10-17). Paseo's file explorer and file pane read a
workspace's directories and files (`list_directory`, `read_file`, server/file-explorer/service.ts at
b63a325); these are their read-only part, for the command center's file pick, the Files panel and
file links in chat.

- `workspace.files.list { projectRoot, path?, includeIgnored? }` answers
  `{ entries: [{ name, path, kind: 'file' | 'directory', size?, modifiedAt? }], truncated? }`: the
  entries of the directory `path` (the root when left out), directories first, then by name (code
  points). `size` (bytes) is given for files; `modifiedAt` is ISO 8601. At most 1000 entries
  (`WORKSPACE_FILES.maxListEntries`), 20 000 looked at, 3 s; then `truncated: true`. Dot-names are
  listed (a client may hide them).
- `workspace.files.read { projectRoot, path, includeIgnored? }` answers
  `{ path, content, size, modifiedAt? }`: the file's bytes as UTF-8 text (a BOM kept), at most 1 MiB
  (`WORKSPACE_FILES.maxReadBytes`), else `1000 too_large`. A NUL byte, over 30% control characters
  (Paseo's isLikelyBinary) or invalid UTF-8: `1000 binary`. Nothing else is decoded or previewed.
- **`projectRoot`** as §12.3 (`-32602 invalid_path`, `1001 not_directory`); its real path is the root.
- **`path`**: relative to the root, `/`-separated, 1–4096 code points, no leading `/`, drive, `\`,
  NUL, `.`, `..` or empty segment; else `-32602 invalid_path`.
- **Block list** (`blockedFilePath` in `@anhlp/alp-protocol`, checked by alpd and by the gateway,
  case-insensitively, on every segment): directories `.git` (also a `.git` file), `.alp` (ALP
  configuration: its library overrides hold MCP and provider env values, read redacted through
  `library.get`), `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `gcloud`; names starting
  with `.env` (`.env.local`, `.envrc`), `id_` (SSH keys under any name: `id_rsa`, `id_ed25519.pub`,
  `id_work`) or `service-account`/`service_account`/`serviceaccount`, and names ending in `_history`
  or `.tfstate.backup`; names `.netrc`,
  `_netrc`, `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.pgpass`, `.htpasswd`, `.git-credentials`,
  `.dockercfg`, `.boto`, `.s3cfg`, `.mcp.json`, `auth.json`, `kubeconfig`, `settings.local.json`,
  `.vault-token`, `application_default_credentials.json`, `token.json`, and `gh/hosts.yml`; names with a
  dotted part (the extension aside, a leading dot ignored) `credential(s)` or `secret(s)`
  (`secrets.yaml`, `prod.secrets.yaml`, `.credentials.json`, a `secrets/` directory), except
  source code (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `py`, `go`, `rs`, `java`, `kt`, `rb`, `php`,
  `cs`, `swift`, `c`, `cpp`, `h`, `scala`, `dart`, `vue`, `svelte`…; never a data or config format:
  `secrets.json`, `secrets.yaml`, `credentials.toml`, `secret.txt` stay blocked); extensions `pem`,
  `key`, `p12`, `pfx`, `p8`, `jks`, `keystore`, `ppk`, `der`, `gpg`, `pgp`, `asc`, `kdbx`, `ovpn`,
  `tfstate`, `tfvars`. A blocked path is refused (`1003 blocked_path`) and never listed, with or
  without `includeIgnored`. alpd also refuses (`1003 blocked_path`) a file whose content holds a
  private key (a PEM or OpenSSH `-----BEGIN … PRIVATE KEY-----` header, a PuTTY key), whatever its
  name, exempt source files included. The list over-blocks some ordinary files (`id_card.md`,
  `secrets/` of a code base, an i18n `auth.json`, AsciiDoc `.asc`) on purpose. It is a floor, not a
  guarantee: any other file may hold a secret, which is why the permission is never a default.
- **`.gitignore`**: without `includeIgnored: true`, a path Git ignores is not listed and is refused
  (`1003 ignored`). alpd asks Git itself, one `git -c core.fsmonitor=false check-ignore --no-index
  --stdin -z` per request (`packages/daemon/src/gitignore.ts`), so the rules are Git's exactly: every
  `.gitignore` on the way, `.git/info/exclude`, `core.excludesFile`, a path inside an ignored
  directory, `!` re-includes. `--no-index`: the index is not read, so a tracked file a rule matches is
  hidden too. The workspace is not trusted, so Git runs boxed in: the Git found on the absolute
  entries of PATH outside the workspace, run by its absolute path (never a `git` in the workspace,
  which a relative or empty PATH entry, an entry such as `<workspace>/node_modules/.bin`, or Windows
  searching the working directory first, would pick), an argument list, no
  shell, the root's real path as its working directory, the paths on stdin separated by NUL and
  each sent as `./<path>` (no name is ever an argument, and none is read as pathspec magic such as
  `:(glob)…` or `:!…`), an environment without alpd's own `GIT_*` variables (`GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`), `core.fsmonitor` off, at most 4 Git processes at once in alpd with at most
  64 requests waiting, at most 2 s per request (then its whole process group is killed), and no more
  output than it was sent. A timeout, a crash, a fatal error (such as a repository Git refuses as
  unsafe, or a `.git` it cannot use), a full queue or an answer naming a path that was not asked
  **fails closed**: the paths count as ignored (a listing of the root then shows nothing, of a
  directory answers `ignored`). Git not installed, or a root with no `.git` in it or above it: no
  rules apply, and only the block list hides anything. `includeIgnored` runs no Git. Hiding ignored
  files is a default view, not a boundary.
- **Confinement**: the root is the real path of `projectRoot`; every directory on the way is
  checked as reached by name (a real directory, not a link, at its own real path), and again after
  the read with the same device and inode; else `1003 linked`. Links are never listed or followed.
  A file must be a regular file with one name (`nlink` 1: a hard link may give a file from anywhere a
  second name inside), at its own real path; it is opened with `O_NOFOLLOW | O_NONBLOCK` (no final
  link, no wait on a FIFO), checked by its handle (same device and inode as by name before, and by
  name after the read), else `1003 linked`. Missing, or not a regular file (or not a directory for
  list): `1001 not_found`. **Residual risk**, as §12.3: a writer racing inside the workspace that
  swaps a directory on the way for a link and back, between checks, could have a file outside read;
  Node has no `openat` walk. Such a writer (an agent or a process of the user) can already read that
  file itself.
- **Errors** name only the caller's own relative path, never a host path or anything read from a
  file; a failure that is not one of the reasons above answers `1000` with a fixed message, and alpd
  logs it.

The gateway exposes both with the `files.read` permission only (docs/alp/remote-gateway.md §5.10).

## 13. Compatibility notes for this revision

**Additive** (old clients unaffected):
- Typed tool-call details (§8.6): `read`, `edit`, `write`, `search`, `fetch`, `sub_agent`, `plan` and
  `plain_text` beside `shell` and `unknown`, and any later detail type. A client that knew only `shell` and
  `unknown` needs a default branch for the rest; Claude's tools other than Bash, which were `shell` items
  named `shell` with a `Name {json}` command, are now items named after the tool with a typed or `unknown`
  detail.
- The `usage` event and the session snapshot's `usage` (§8.5); old clients ignore an unknown event
  type (§7) and unknown snapshot fields.
- `question.watch` `attention`, the `attention` event, `session.attention.clear`, the `attention` of
  session rows and the `origin` of `user_message` (capability `session.attention`), §8.1, §12.2 (issue
  #120). Old clients ignore the event type and properties; an old alpd ignores the param.
- `question.watch` `turns` (capability `question.watch.turns`) and `workspace.files.search` (capability
  `workspace.files`), §12.2, §12.3; error reason `not_directory`.
- `workspace.files.list` and `workspace.files.read` (capability `workspace.files.read`), §12.4; error
  reasons `blocked_path`, `ignored`, `linked`, `binary`, `too_large`; exports `WORKSPACE_FILES` and
  `blockedFilePath` (root).
- `session.list` `limit` / `cursor` / `query` / `projectRoots` and `nextCursor`, and `question.watch`, with capabilities
  `session.list.page` and `question.watch` (§12.1, §12.2). Without the new params `session.list` answers
  as before; its order now breaks ties of `updatedAt` by `id`.
- The project, task, library and settings methods of §15 with their capabilities; error codes `1003` and `1005`;
  the `x-alp` annotation of every method in `methods-v1.json` (effect, resource scope, capability, risks), which
  validators ignore.
- `daemon.hello` result `capabilities`; `daemon.hello` params `capabilities` (reserved).
- `error.data.reason` on handshake, validation, id, batch and size errors; `data.supported`, `data.issues`.
- Result schemas for every method; `Envelope.cursor` and `session.attach.after` in the schema (alpd
  already sent and accepted them since ALPD §66).
- Schema accepts unknown event types and item kinds.
- Exports `RPC_ERROR`, `CAPABILITY` (root), `@anhlp/alp-protocol/contract` (validator, schema data),
  `@anhlp/alp-protocol/schema/methods`, `@anhlp/alp-protocol/conformance`; types `RpcMethodMap`,
  `RpcParams`, `RpcResult`, `Capability`, `ErrorReason`.

**Behaviour changes** (deterministic now; previously undefined or inconsistent). None affects a request
that existing clients send (checked against every call site in `packages/cli`, `packages/client`,
`integrations/paseo` and the full test suites):

| Before | Now | Why |
|---|---|---|
| Built-in params were checked ad hoc; bad input often failed `1000`/`1001` after partial work | Checked against the schema first: `-32602 invalid_params`, nothing runs | Deterministic, no side effects |
| A notification ran its method | Dropped unrun | JSON-RPC forbids answering, so its failures were invisible |
| `id: null` with a method ran without an answer; other bad ids were echoed | `-32600`, `id: null`, unrun | One rule for ids JavaScript and Rust both represent |
| A batch, or a non-object frame without id, got no answer | `-32600` with `id: null` | A client can tell it was refused |
| `params` array/scalar reached the handler | `-32602` | |
| Several frames in one read over 16 MiB together closed the connection | Each frame is measured alone | Spec: the limit is per frame |
| A result over 16 MiB was sent and made the client drop the connection | `1000 response_too_large` | |
| No-store daemon: a cursor older than the in-memory log replayed with a silent gap | `reset: true` | Replay never skips silently |
| `session.rename` limit counted UTF-16 units | Code points | Same limit in every language |
| An extension could register under `task.`, `team.`, `library.` or `settings.` | Refused (`1006`), as for every namespace a v1 method uses, served by that daemon or not | No extension shadows a method a newer daemon serves |

**Schema corrections** (the schema was wrong, alpd unchanged): `session.configure.mode` is optional
(alpd keeps the current mode; Paseo sends it without `mode`); `session.create.sessionId` has its
pattern `^[A-Za-z0-9_.:-]{1,128}$`; `session.rename.title` needs a non-whitespace character.

**Decisions on existing conflicts**:
- `PROTOCOL_VERSION` stays `1`: nothing above removes or changes a shape an existing client relies on.
- `1001` for an unknown and for an expired session stays one case (no tombstone); clients treat both
  as gone.
- Plain runtime errors whose message says "is not open" keep mapping to `1001`, others to `1000`.
- `session.prompt` with `outcome: "failed"` stays a success response (the request was handled; the
  runtime refused the prompt), as alpd has answered since ALPD §66.

## 14. Proposed RPCs (not supported)

These proposals carry forward the Paseo remote design work (Task 09A); the table is self-contained.
**None is implemented**: none is in `RPC_METHODS`, the schema's `methods`, or a capability, and calling one
answers `-32601`. Each needs its own capability when implemented.

| Proposed | Priority | Notes for the contract |
|---|---|---|
| Principal on connections; `accept(send, { principal })` | P0 | Authentication stays outside `daemon.hello` (gateway). Hello result would add `principal { kind, grants }`. |
| Gateway reasons of `1003 forbidden` (`grant`, `outside_workspace`, `spec_field`, `local_only`); `1005 unavailable` reasons `feature_disabled`, `maintenance`, `restoring` | P0 | The codes exist (§5.1, §15); a gateway adds its reasons. |
| `session.create` spec allow-list for remote principals | P0 | Refuse `env`, stdio `mcpServers`, `workdir`, `writeRoot`, `copy*`, `restore`, `keepThread`. |
| Project/workspace registry; `session.create.workspaceId` | Implemented (§16) | Versioned migration of `state/web-workspaces.json`; shared pins and scoped add of existing granted directories. Worktree creation/removal remains proposed. |
| `workspace.git.status/diff` | P1 | Read-only; results must fit `MAX_FRAME` (cap or chunk). `workspace.files.search`, `workspace.files.list` and `workspace.files.read` are implemented (§12.3, §12.4). |
| `provider.list/refresh/diagnose/save/remove`, `library.test` | P1 | Probes spawn processes: separate `exec.probe` grant; timeouts; cancellation when the caller's connection closes needs the probes in `@anhlp/alp-client` to take an abort signal. |
| `subscribe` / `unsubscribe` and notification `notify` | P1 | Old clients ignore unknown notifications (`AlpClient` handles only `event`). |
| `host.directories.suggest`, `project.create_directory`, shared attention | P2 | Product decisions pending. Per-client attention for finished turns is `question.watch` `turns` (§12.2); attention shared between clients (acknowledged on one, cleared on all) is not. |

Open decisions carried from 09A: tombstones for expired trees; generalising durable receipts beyond prompts (`task.create`
dedupes only within one alpd process, §10).

## 15. Project, task, library and settings methods

What a client needs besides sessions, so that a client on another machine (through a gateway) never reads the daemon
user's `ALP_HOME` or a project, nor runs ALP core itself. alpd answers from its own host with core's logic; it resolves
the project, serializes its own writes, maps core's refusals to the codes of §5 and keeps secrets out of what it
answers. Shapes are in `methods-v1.json`; each method's `x-alp` annotation gives its effect, the resource a gateway
authorizes (`scope.kind`, and `scope.param`, the param naming it), its capability and its risks.

### 15.1 `projectRoot`

- An absolute path on the daemon host, already normalized (`path.resolve(p) === p`: no `..`, `.`, trailing separator
  or duplicate separator), else `-32602 invalid_path`.
- It must be a directory holding a real `.alp/` directory: missing → `1001 not_alp_project`; `.alp` a symlink →
  `1003 unsafe_path`. Core also refuses symlinks inside `.alp` on the paths it reads or writes (`1003 unsafe_path`).
- alpd **never walks up** to a parent: the project is exactly the path given, so a gateway authorizes by comparing the
  string with the projects it granted, never by prefix. A directory inside a project is not that project.
- Results echo the `projectRoot` given. No other path of the daemon host appears in these results except in
  `syncErrors` (§15.3) and `unreadable[].file` (relative to the project).

### 15.2 Tasks (capability `task`)

- `task.list` answers the rows the Paseo Tasks panel shows (`taskRow`), files it could not read, and `revision`, a
  hash of the answer that changes when any task does (cheap change detection for polling).
- Writes go through core under the project's task lock (in alpd, then across processes), as `alp task` and agents'
  `alp_task` do. A lock held for 5 s (another `alp` process, a backup) answers `1005 busy`; retry later.
- `taskRow.rev` changes with every write. `task.update` and `task.gate.resolve` take it back as `ifRev`; a task changed
  since fails `1004 revision_conflict` and changes nothing. A change its state refuses fails `1004 task_state`.
- `task.update` closes (`reason: done`, `note` as summary) or reopens; closing the last open child of an epic answers
  `landed`, the first line of its report. `task.gate.resolve` approves a gate; when it was a formula's human step, the
  task closes too. Writes are recorded as the user's (`by: "user"`); identity claims in params are not accepted.
- Events: none in v1. Clients poll `task.list` (the Paseo panel polls every 5 s) and compare `revision`; a subscription
  is proposed (§14).

### 15.3 Library (capability `library`)

- Kinds: `agents`, `skills`, `mcp`, `hooks`, `teams`, `providers`; scopes: `library` (the daemon user's `ALP_HOME`, a
  host resource) and `project` (`<projectRoot>/.alp`). Providers live only in the library. Without `scope`,
  `library.get` answers the version that applies (project, else library, else built-in). Reads with a `projectRoot`
  still read the host library and built-ins.
- **Secrets**: `library.get` replaces every string value of an MCP server's `env` and `headers` and of a provider's
  `env` by `{ "$secret": "keep" }` and lists their JSON Pointers in `secrets`. In `library.save` a marker keeps the value
  stored at that place in the entry the save replaces (or, when the scope has none yet, in the entry that applies), a
  string replaces it and a missing key removes it. A marker with nothing stored to keep, or anywhere else in the
  content, fails `-32602 secret_marker`: a placeholder is never written. `command`, `args`, `url` and hook commands
  are not secrets and are answered as they are.
- **Revisions**: `revision` is opaque and keyed per alpd process (an HMAC of core's content hash), so it never reveals
  a hash of secret content. A revision read before an alpd restart no longer matches: the save fails
  `revision_conflict` and the client reads the entry again. `revision: null` creates, a string replaces exactly that
  version, an omitted revision overwrites. alpd checks and writes one library change at a time; core checks the
  revision again as it writes, so a writer outside alpd (the `alp` CLI) is caught too, except in the instant between.
- **Code execution**: an MCP server's `command`, a hook's `command` and a provider's `command`/`env` run on the daemon
  host when used. Saving, duplicating or renaming those kinds, or an agent that names them, is administrative.
- `sync: "known-projects"` on a team save rewrites the team profiles of `.alp/settings.json` in `projectRoot` and, for
  the library scope, in every project root alpd's session records name. It answers how many changed and one
  `"<projectRoot>: <message>"` per project that failed. Default `none`.
- `library.models` lists ALP's models and those of enabled ACP providers (ids and labels only).
- `library.skills.set` sets the skills the library gives an agent (`role-skills.json`); each must be in the library.

### 15.4 `team.list` (capability `team`)

The teams a project (or, without `projectRoot`, the library) can use: built-ins, then the library, then the project,
each with its `source`, what it overrides, and `error` when it does not load. `session.preview` answers which team a new
session would run with: the same resolution as `session.create` (the chosen `workflow`, else settings'
`workflow.mode`, else `custom`; a folder without settings counts as init's, which name `pho`). A preview's `team`
may be sent back as `workflow`, `custom` included.

### 15.5 `settings.language` (capability `settings.language`)

The language the daemon user reads (ALPD §54): `language` null means unset, so `default` applies. `set` keeps every
other key of `settings.json`; a broken file fails `1000 unreadable`.

### Scheduled continuations (`schedule` capability)

The local daemon advertises `schedule` only with a persistent store and ALP_HOME.
All four methods are local-only; the remote gateway prohibits them.

| Method | Params | Result |
|---|---|---|
| `schedule.create` | `{ projectRoot, sessionId, dueAt, prompt }` | `{ job }` |
| `schedule.list` | `{ projectRoot, status? }` | `{ jobs }` |
| `schedule.get` | `{ projectRoot, id }` | `{ job }` |
| `schedule.cancel` | `{ projectRoot, id }` | `{ job }` |

`projectRoot` is required and absolute for every method, compared as the canonical
filesystem path. Wrong-project get/cancel behaves as not found. `dueAt` is an ISO
timestamp with seconds and explicit Z/UTC offset; it is stored as UTC. The target
must be a live root of that project. Prompt is nonblank, at most 8000 code points.
IDs have shape `sch_` plus sixteen lowercase hex digits. Unknown status and invalid
params return -32602; missing jobs/targets return 1001; cancelling a terminal job or
one currently delivering returns 1004. List sorts by deadline then id.

`ScheduleJob` includes id/projectRoot/sessionId/prompt/dueAt/status/attempts,
createdAt/updatedAt and optional attemptedAt/lateByMs/deliveredAt/failedAt/cancelledAt/
lastError `{ message, code? }`. Status is pending/delivered/failed/cancelled.
Delivered acknowledges the prompt, not completion of the agent's work. Failed may
mean execution is unknown: timeout does not cancel the outstanding runtime request;
a late ACK updates lastError to delivery_accepted_late without retry or status change.
See [scheduler semantics](../alp/schedules.md) and ALPD §71 for restart, bounded waits,
missed deadlines, approval and receipt deduplication.

## 16. Project/workspace registry (`workspace.registry`)

The daemon is the only writer of `state/web-workspaces.json`. It migrates the complete legacy
Paseo envelope to version 1, retaining project/workspace IDs, titles, pins, labels, custom names,
archives, idempotency keys and session placement. An exact private `web-workspaces.json.legacy-v0.json`
backup precedes migration. Invalid JSON/schema/reference data fails closed and retains the file.
The state directory is mode 0700 and registry/backup files are mode 0600. Atomic replacement gives
process-crash persistence; this does not promise power-loss durability.

| Method | Params | Result |
| --- | --- | --- |
| `project.list` | `cursor?`, `limit?` (1–500) | `projects`, `revision`, `total`, `nextCursor` |
| `project.register` | `directory`, `ifRevision`, `requestId` | `project`, `revision`; creates a default workspace if missing |
| `project.remove` | `projectId`, `ifRevision`, `requestId` | `project`, `revision`; unregisters/archives metadata, deletes no filesystem data and stops no sessions |
| `workspace.list` | `cursor?`, `limit?` (1–500) | `workspaces`, `revision`, `total`, `nextCursor` |
| `workspace.get` | `workspaceId` | `workspace`, `revision`; archived records remain addressable |
| `workspace.update` | `workspaceId`, `title?`, `pinned?`, `archived?`, `ifRevision`, `requestId` | `workspace`, `revision` |

`revision` is a registry-wide integer. Mutations are serialized copy-on-write and publish only
after replacement succeeds. A failed save throws with no committed revision or metadata change.
An identical successful `(operation, requestId, payload, ifRevision)` retry returns its original
result, including after restart; replay precedes CAS. Reusing an ID with another payload returns
1004 `request_conflict`; stale CAS returns 1004 `stale_revision`. Retain the original ID and
precondition when reconciling an uncertain outcome. A new edit after refresh uses a new ID.
Canonical realpath deduplicates future registration while preserving legacy alias IDs and maps.

`session.create` additionally accepts `workspaceId`, resolving cwd on the host; `spec` may omit cwd
in that case. A supplied cwd must have the same canonical identity. Existing/resumed roots must
also agree. Placement persists before runtime open; failed opens release newly reserved placement.
Old cwd clients keep their launch behavior and receive deterministic default placement. Bridge
placement preparation and all label/name/archive mutations use the owner-only `registry.owner`
domain operations; that method never accepts a client replacement snapshot and is denied remotely.

`projectRoots`, `authorizedRoots`, `includeRemoved` and `includeArchived` support the trusted local
adapter's filtering/authorization. The gateway supplies them itself and never forwards remote
values for them. Filtering and totals precede pagination. Scoped mutations recheck every affected
canonical directory before receipt replay/CAS, including archived workspaces on project removal.
