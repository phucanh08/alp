# Characterization Tests

Read when pinning current behavior before a refactor, especially for code with few or no tests.

## Purpose

A characterization test records what the code does now, not what it should do. It
is the safety net that makes "behavior preserved" a checked claim instead of a hope.

## Choosing the seam

- Test at the highest seam the refactor does not cross: if you restructure the
  internals of a module, pin the module's public entry points, not its internals.
- If the refactor moves an interface, pin both sides: callers' observed results and
  the moved code's outputs.
- Prefer existing test infrastructure and style; add a new harness only when none
  reaches the seam, and keep it inside owned paths.

## Writing them

1. List inputs that exercise each branch you will touch: typical, empty, boundary,
   invalid, large, unicode or encoding edge cases, error paths.
2. Run the current code on each input and record the actual output, return value,
   thrown error type and message, side effects (files, calls, logs), and ordering.
3. Assert exactly what was recorded, including odd behavior. Mark surprising cases
   with a comment such as "pinned current behavior; possible bug, reported".
4. Run the tests on the unchanged code; all must pass. A failing one means the
   recording is wrong, not the code.
5. Prove the net catches change: temporarily alter one touched branch and confirm
   at least one test fails, then restore it.

## Golden output and snapshots

- For large or structured outputs (rendered text, serialized data, CLI output),
  capture a golden file from the current code and diff against it.
- Normalize nondeterminism before comparing: timestamps, random IDs, absolute
  paths, map ordering, locale. Seed randomness where the code allows.
- Review the golden file once by eye; a snapshot of an error page pins nothing useful.

## Side effects and dependencies

- Record calls to collaborators with a fake or spy at the module boundary, not deep
  inside the code being refactored.
- For filesystem effects, run in a temp directory and assert the resulting tree.
- Do not hit real external services; use the project's existing fakes or recorded
  fixtures.

## Keeping or removing them

- Keep characterization tests that cover public behavior; they become regression
  tests.
- Remove or rewrite ones that pin internals the refactor intentionally eliminated,
  after the refactor is verified, and say so in the handoff.
- Never edit an expected value to make a post-refactor run pass. That is a behavior
  change and needs a decision.
