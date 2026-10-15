# Integrating clients with ALP protocol v1

For the portable client SDK (Task 07) and every other client. The contract is
[alp-json-rpc-v1.md](alp-json-rpc-v1.md); this note lists what a client must do, and what needs
compatibility handling with daemons before this revision. Nothing here requires changing a client to
keep working: existing `AlpClient`, CLI, ACP adapter and Paseo integration pass the full test suites
unchanged.

## Must

- **Handshake.** Send `daemon.hello { protocolVersion: 1, client: { name, version } }` first. Read
  `capabilities ?? []` from the result and gate features on it; never on `daemonVersion` or a package
  version. On `1006` from hello the daemon is incompatible: newer daemons add
  `data: { reason: 'protocol_version', supported }`, older ones send no `data`.
- **Ids.** Safe integers or strings of at most 128 code points; never `null`; unique among a
  connection's in-flight requests. Answers may arrive in any order and interleave with events.
- **No notifications to the daemon.** Every request carries an id; a request without one is dropped
  unrun and never answered.
- **Frames.** One JSON text plus `\n` is at most `MAX_FRAME` bytes, the newline included (a JSON text of
  at most `MAX_FRAME - 1` bytes); a WebSocket message obeys the same limit. Measure each frame alone:
  several frames in one read may together exceed the limit. The current client SDK line decoder
  measures frames independently.
- **Unknown things are ignored**: properties anywhere, event types, item kinds, notification methods
  other than `event` (a future `notify`), capabilities and error reasons.
- **Errors.** Branch on `code` and `data.reason`, never on `message`. Treat unknown codes as `failed`.
  `-32602 invalid_params` now answers bad input that older daemons answered `1000` or `1001`; a client
  that classifies "my request was wrong" should accept all three from an old daemon.

## Events and replay

- Track the last `cursor` per root, from envelopes that have one. Envelopes without `cursor`
  (re-announcements, waiting questions) never move it.
- Reconnect: hello, then `session.attach { sessionId: root, after: last }` when the daemon lists
  `attach.after`. Buffer that root's events until attach answers: replay arrives before the response
  carrying `reset`. On `reset: true`, clear the projection and saved cursor, then apply buffered
  events in order and resume live processing. The result's `cursor` is the tip. A reset without
  retained history leaves history unavailable; use the returned session summary.
- Without `attach.after`, attach with `replay: true` and no `after`, and rebuild from scratch.
- `session.create { history: 'replay' }` sends a digest, not a cursor-ordered replay: a cursor-tracking
  client creates with `history: 'skip'` and attaches with `after`.
- `1001` on attach means the tree is gone (never existed or removed by retention); drop the cache, do
  not recreate.
- `replay: false` subscribes to future events and still announces pending questions; it cannot
  rebuild history. Missing-history gaps are not checked in this mode.
- `seq` is for display ordering only; restart reconciliation and synthetic events may reuse it.
  Use `cursor` for replay and deduplication.

## Requests, timeouts, retries

- A client-side timeout does not cancel anything on the daemon; there is no request cancellation in v1.
  Cancel a turn with `session.interrupt`.
- Methods marked idempotent in the contract's §12 may be resent with the same arguments.
  `session.prompt` is safe to resend only while receipts are retained and the daemon lists
  `prompt.receipts`: resend with
  the **same** `clientMessageId` and content. `duplicate: true` answers the first outcome.
  `1004 outcome_unknown` is final for that id: check the timeline, then send again with a new id if the
  prompt did not arrive. `1004 key_conflict` means the id was reused with other content.
- `outcome: 'failed'` in a successful `session.prompt` result is the runtime refusing the prompt, not a
  transport failure.
- Methods marked non-idempotent (`session.create`, `session.close`, `question.answer`,
  `session.message`, `assignment.recall`, extension registration) require checking state after a lost
  answer before retrying. Receipt cleanup can eventually remove deduplication, so never reuse prompt ids.

## Compatibility with older daemons (alpd ≤ 0.10.0 before this revision)

| Behaviour | Older daemon | This revision |
|---|---|---|
| `capabilities` in hello | absent | listed |
| `attach.after`, `cursor`, `reset` | supported, unlisted | listed |
| `prompt.receipts` | supported with a store, unlisted | listed when a store exists |
| bad params | often `1000`/`1001`, sometimes after partial work | `-32602 invalid_params`, nothing runs |
| a notification | runs | dropped |
| a batch | no answer | `-32600`, `id: null` |
| `id: null` | ran, no answer | `-32600`, `id: null`, unrun |
| other bad ids | ran and echoed the bad id | `-32600`, `id: null`, unrun |

A client that needs `attach.after` from an older daemon may probe it (attach with `after` and check that
the result has `cursor`), but should prefer capabilities.

## What the protocol package offers

- Root: `PROTOCOL_VERSION`, `MAX_FRAME`, `ERROR`, `RPC_ERROR`, `CAPABILITY`, `RPC_METHODS`,
  `AlpRpcError`, `encodeFrame`, `decodeFrame`; types `RpcMethodMap`, `RpcParams<M>`, `RpcResult<M>`,
  `Capability`, `ErrorReason`, `Envelope`, `AlpEvent`, `SessionSummary`, ….
- `@anhlp/alp-protocol/contract`: the schema as data and a dependency-free validator
  (`validateParams`, `validateResult`, `validateDefinition`) for tests or debug builds.
- `@anhlp/alp-protocol/schema`, `…/schema/methods`: the JSON Schemas.
- `@anhlp/alp-protocol/fixtures/v1/cases.json`: golden values a client's decoder tests can load.
- `@anhlp/alp-protocol/conformance`: the daemon conformance runner (it tests daemons, not clients).
