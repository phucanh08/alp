---
name: test-strategy
description: "Design tests for a new feature or change by behaviour and risk: unit, integration, contract, end-to-end, regression, failure paths and edge cases, using the project's existing frameworks. Use when planning or reviewing tests for new or changed behaviour. Not for debugging an existing failure (use bug-loop) or tool-specific test setup (use web-testing if installed)."
---

# Test by behaviour and risk

## When to use
- A feature, endpoint, schema or behaviour change needs a test plan before or during work.
- A lead is writing the test part of a brief for a peer.
- A reviewer asks whether the tests for a change prove what it claims.
- A public contract (API, CLI, file format, event) changes and compatibility matters.

## Not for
- A test or behaviour that already fails: use bug-loop to reproduce and fix it.
- Framework-specific setup or browser automation: use web-testing if installed.
- Chasing a coverage percentage; this skill sets no fixed target.

## Prerequisites
- Read ALP.md and the project's test command, layout, frameworks, fixtures and helpers.
- Know the intended behaviour from the user request, spec or contract, not from the
  implementation being tested.
- Know the owned paths; peers add tests only inside them.

## Workflow
1. **List behaviours.** Write each observable behaviour of the change as one sentence:
   input or event, expected result, and who depends on it.
2. **List risks.** For each behaviour, what could break, how likely, and how costly.
   Include failure paths (invalid input, unavailable dependency, timeout, permission
   denied) and the edge cases from the risk-matrix checklist that apply.
3. **Pick the cheapest proving test.** For each risk choose the lowest level that would
   fail if the risk occurred: unit for pure logic, integration for wiring and real
   storage, contract for shapes others depend on, end-to-end only for a critical user
   path no lower level covers. One good test per risk; drop tests that prove nothing new.
4. **Reuse.** Use the existing framework, fixtures, factories and helpers. Add a new
   helper only when two or more tests need it; never add a test dependency without
   approval routed to main.
5. **Write the plan.** A short table: behaviour, risk, level, test location, and whether
   it exists already. Put it in the brief, task note or handoff.
6. **Write the tests.** Name each test after the behaviour. Assert observable outcomes,
   not internal calls. Mock only external boundaries, and keep the claimed behaviour
   under test.
7. **Show they fail without the change.** Run new tests against the code before the
   change (stash or comment out the change in an isolated copy, or write tests first)
   and record the failure. Then run them with the change and record the pass.
8. **Run the surrounding suite** with the project's test command and report results.

## Constraints
- Expected values come from the requirement or independently worked examples, never
  from running the implementation.
- Do not weaken, skip or delete an existing test to make a change pass; report it.
- Tests must be deterministic: control time, randomness (fixed seed), ordering,
  network and shared state. No sleeps as synchronisation.
- Flaky test rules: do not merge a known-flaky test; if one appears, record the failure
  rate and conditions, quarantine only with the project's mechanism and an owner, and
  hand diagnosis to bug-loop.
- A regression test sits at the seam where the bug or risk actually lives.

## Verification
- Each listed risk maps to a test or to an explicit "accepted, not tested" with reason.
- Each new test was observed failing without the change and passing with it, or the
  handoff says why that run was not possible.
- The project's test command passes for the affected area; commands and results are
  in the handoff.
- No new test depends on wall-clock time, test order or external services.

## Failure handling
- No usable test seam: propose the smallest seam change to lead or main; do not
  restructure code on your own authority.
- The pre-change run is impossible (no history, generated code): state the limit and
  use fault injection in an isolated copy if risk justifies it.
- An existing test fails before your change: stop, record it, and route it to bug-loop.
- Requirement unclear for an edge case: list it as an open question; do not encode a guess.

## References
- [references/risk-matrix.md](references/risk-matrix.md) — read when listing risks and edge cases and choosing test levels (steps 2-3).
- [references/contract-tests.md](references/contract-tests.md) — read when the change touches an API, protocol, schema, file format or other consumer-facing contract.
