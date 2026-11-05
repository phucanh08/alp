---
name: safe-refactor
description: "Restructure code while preserving observable behavior and architectural invariants, using characterization tests, compatibility analysis, caller impact, and small green steps. Use when renaming, moving, extracting, splitting, or simplifying code that must behave the same. Not for fixing a bug (bug-loop) or adding a feature (feature-architecture)."
---

# Safe Refactor

## When to use

- Rename, move, extract, inline, split, or merge code, modules, or files.
- Replace an internal implementation behind an unchanged interface.
- Remove duplication or dead code where behavior must stay the same.

## Not for

- Fixing incorrect behavior or a regression: use bug-loop.
- Adding a feature or new public surface: use feature-architecture.
- Changing behavior "while we are here": that is a separate task with its own approval.

## Prerequisites

- An assigned scope and a stated goal for the refactor (what gets simpler or safer).
- A runnable test command, or authority to add tests within owned paths.
- Read ALP.md and project instructions for test, lint, type check, and build commands.

## Workflow

1. Define the invariant: the behavior, public surface, and architecture rules that
   must not change. Write it in the brief or task notes.
2. Find every caller and dependent: search imports, symbol references, string
   lookups (reflection, routing tables, config keys), generated code, docs, and
   scripts. Record the search commands and the count of hits.
3. Run compatibility analysis on anything exposed beyond the module: public API,
   exported symbols, config formats, persisted data, CLI flags, protocol messages.
4. Pin current behavior with characterization tests before editing, including odd
   or surprising behavior. Run them and confirm they pass on the unchanged code.
5. Plan small steps, each leaving the tree building and green. Order them so any
   step can be reverted alone.
6. For each step: change, run the characterization tests and the relevant suite,
   then continue. Commit or checkpoint only as the session's rules allow.
7. For risky changes, choose a risk control: a feature flag, a parallel path with
   output comparison, or a documented rollback. Prefer the cheapest that fits.
8. Compare before and after: same tests, same outputs for the same inputs, same
   public surface; measure performance only if the code is on a hot path.
9. Remove temporary shims, flags, and duplicate paths once the switch is verified,
   or record why they stay and who removes them.

## Constraints

- No behavior change mixed with the refactor. If a test must change its expected
  value, stop: that is a behavior change.
- If behavior must change to complete the refactor, stop, state why, and route the
  decision upward (peer -> lead -> main -> user).
- Do not break a public or persisted contract without an explicit recorded decision;
  prefer a compatibility shim or deprecation path.
- Keep project architecture rules intact; run the project's boundary or lint checks.
- Stay inside owned paths. A caller outside them is reported, not edited.
- Do not weaken, skip, or delete tests to get green.

## Verification

- Characterization tests and the project's relevant suite pass before and after.
- Public surface diff is empty, or every change is covered by an approved decision.
- Caller search re-run after the change finds no stale reference.
- Hand off: invariant, caller search commands and results, before/after test runs,
  compatibility notes, risk control used, and any remaining shim.

## Failure handling

- A characterization test fails after a step: revert that step, shrink it, retry.
- Behavior cannot be pinned (no harness, nondeterminism): report the gap and the
  proposed harness; do not proceed on an unpinned risky change.
- A caller sits outside owned paths: report it with the needed change to the
  assigning agent.
- Odd behavior looks like a bug: keep it, pin it, and report it as a separate
  bug-loop candidate.

## References

- [references/characterization-tests.md](references/characterization-tests.md) — read when pinning current behavior before the first edit (step 4).
- [references/compatibility-checklist.md](references/compatibility-checklist.md) — read when the refactor touches anything exposed beyond its module (step 3).
