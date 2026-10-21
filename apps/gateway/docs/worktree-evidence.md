# Managed user worktrees — t-15b0.11 candidate evidence

Base: `4d9853c0dd7817090f3b54349c8542c7531694b0` (`origin/main` fetched 2026-10-21).
Isolated checkout: `/tmp/alp-t15b011`. No user-checkout source edits, push, PR or merge.
Runtime: Node **22.23.3**; Git **2.54.0 (Apple Git-157)** on macOS. Acceptance of the
final committed range belongs to an independent reviewer and main; these are execution results.

## Behavior and security

- Sole daemon registry writer persists generated native intents before Git, fingerprints actor,
  scope epoch, requestId, payload and CAS revision, then atomically publishes row/provenance/receipt.
  Missing prepared save causes zero Git mutations. A failed final save returns failure with no
  published workspace/grant. Actual subprocess exit86 after native creation, then restart/retry,
  produces one checkout. Removal retry after native success/tombstone-save failure works with an
  absent target, preserves its branch and replays the original receipt.
- Host-only private configuration binds exact canonical source + commonDir to existing owner-private
  destination parent. Gateway tokens separately opt into workspace.manage and mapping IDs. Derived
  grants are exact, creator/scope-epoch bound, committed, and revalidated before requests/events;
  parent/sibling/commonDir, foreign principal, revoked mapping, changed branch and backlinks do not
  derive authority. Credential reissue invalidates old scope; secret-only rotation retains scope.
- Git uses absolute trusted executable, sanitized environment, no hooks/fsmonitor/checkout filters,
  bounded output/time and whole-process-group kill. Target-only conditional filters are neutralized.
  Removal uses native non-force worktree remove, rejects dirty/untracked/ignored data, hidden index
  flags, submodules/locks/identity changes, never recursive rm or branch deletion.
- Runtime registers only newly journal-created workspace births; permanent assignment ownership
  precedes native assignment side effects and survives lost live/recall books. It is retained until
  explicit worktree merge/discard; failed/conflicting results remain owned. Atomic admission blocks
  open/delegation races; active sessions/claims/leases/recoverables/results refuse deletion. Saved
  session placement separately refuses deletion; this RPC never deletes history.
- Per-event grant refresh uses bounded no-follow regular-file administrative reads with backlink,
  canonical commonDir/adminpath and branch checks. Mutation proof: restoring native source lookup
  produces **8 Git spawns** (RED); bounded filesystem refresh produces **0** (GREEN), including
  tamper/scope/principal negative cases. No Git process runs for token-event scope refresh.

## Actual checks and artifacts

All service runs use explicit outer scratch ALP_HOME; browser/subprocess fixtures isolate their
homes, credentials, socket/ports and fake provider executables. No paid/native model invocation.

| Check | Actual result / log |
|---|---|
| core/protocol/client/runtime/daemon package tests | 549 pass, 0 fail, 4 Windows-only skips (553 total); `/tmp/alp-t15b011-packages-final.log` |
| Runtime admission correction | RED missing unfinished ownership; GREEN14/14 focused tests, including loss of live/recall before first result; `/tmp/alp-t15b011-admission-{red,green}.log` |
| Native worktree/crash/guards/recovery | 31/31 pass before filesystem-refresh optimization; latest native/security/zero-spawn tests7/7 pass; `/tmp/alp-t15b011-final-native*.log` |
| Grant spawn mutation proof | RED8 vs0; restored GREEN0; `/tmp/alp-t15b011-grant-mutation-{red,green}.log` |
| Gateway package | 75/75 pass; `/tmp/alp-t15b011-gateway-tests.log` |
| Web unit | 200/200 pass; `/tmp/alp-t15b011-web-tests.log` |
| Existing integration inventory/SDK/real gateway | 23/23 pass; `/tmp/alp-t15b011-integration.log` |
| Paseo bridge/cache | 36/36 pass; `/tmp/alp-t15b011-paseo-tests.log` |
| Real browser → gateway → daemon | 2/2 pass, create/branch/restart/delete-files/branch-retained, default controls absent, missing-mapping zero writes, dirty/active/saved-history refusal; `/tmp/alp-t15b011-browser.log` |
| Visual evidence | `/tmp/alp-t15b011-evidence/worktree-created-through-gateway.png`; row bounds checked so Remove stays within sidebar; native Dialog supplies focus/Escape/top layer |
| Types/boundaries/builds | check, check:core, web types and boundaries passed; package/Paseo/web builds passed; `/tmp/alp-t15b011-{check,types,web-types,boundaries,*-build}.log` |

The broad package result predates the final unfinished-admission correction; the focused correction
was verified separately, and the final runtime suite is recorded in the handoff. Independent
exact-head review is required after local packaging; no earlier research/worker result is a verdict.

## Limits and already-triaged follow-ups

Management capability is macOS/Linux-only (`/usr/bin/git`); Windows keeps its existing read-only
backend and does not advertise create/remove. No full Windows or whole issue121 parity claim.
Process-crash persistence follows existing atomic-renames semantics, not power-loss fsync durability.
Same-UID hostile concurrent host tampering is outside an RPC grant's OS isolation boundary.
Partial/ambiguous native artifacts remain quarantined for owner reconciliation, never force-cleaned.

Main recorded follow-ups: **t-c1ba** audited pre-feature adoption; **t-c44a** explicit shared-result
archival (ownership remains conservatively retained); **t-8b8a** backup/restore of the new ledger,
marker and host mapping authority. Fresh restore/older unknown workspaces fail closed rather than
being silently certified. These are not implemented by this candidate. Terminal, fork/rewind,
uploads, old human gates and generic Git operations are outside F.
