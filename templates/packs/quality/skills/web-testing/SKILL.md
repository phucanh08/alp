---
name: web-testing
description: "Write and run web tests with the project's tooling: e2e (Playwright-style), unit and component (Vitest or Jest-style), visual and accessibility checks, performance and load tests (k6-style), and basic security checks in test environments only. Use when adding, fixing, or running web test suites. Not for test design (test-strategy) or diagnosing failures (bug-loop)."
---

# Web Testing

## When to use

- Adding or updating e2e, unit, component, visual, or accessibility tests for a web
  app.
- Making a flaky or slow web suite reliable at the tooling level (selectors, waits,
  isolation, fixtures, traces).
- Running a performance baseline or load test against a test environment.
- Running basic, authorized security checks (dependency audit, header checks, auth
  flow tests) against a test environment.
- A read-only reviewer is asked to assess test code (advice only).

## Not for

- Deciding what to test, at which level, and why: use test-strategy.
- A failing test or regression whose cause is unknown: use bug-loop.
- A security audit or threat review of code: use security-review.
- Building the feature under test: use frontend-development or backend-development.
- Choosing a new test framework, runner, or service: owner decision.

## Prerequisites

- The brief's owned paths and acceptance criteria; ALP.md and project instructions.
- The existing test tooling and commands, read from `package.json` scripts (or the
  equivalent), runner config files, and CI config. Do not infer from folder names.
- Existing tests near the change. They define naming, fixtures, helpers, and how
  the app is started for tests.
- A test environment: local dev server, preview build, or a dedicated test
  deployment. Never production unless the owner explicitly authorized it.
- Test accounts and data from the project's fixtures or seed scripts; never real
  user credentials.

## Workflow

1. Take the cases to cover from the brief or test-strategy output. If none exist,
   list the user-visible behaviors and route the selection upward when it matters.
2. Pick the cheapest level that proves each case: unit for logic, component for
   rendering and interaction, e2e for a few critical cross-page flows. Read
   unit-and-component.md or e2e.md.
3. Reuse existing fixtures, page objects, factories, and helpers before writing new
   ones.
4. Write each test to be isolated: own data, no dependency on order, no shared
   mutable state, cleanup or fresh state per test.
5. Query elements by role, label, or visible text; wait on conditions, never on
   fixed sleeps.
6. Add visual or accessibility checks only where the project already runs them or
   the brief asks; keep snapshots small and deterministic.
7. For performance or load work, read performance-testing.md; establish a baseline
   before comparing, and get explicit authorization for any shared target.
8. For security checks, read security-testing.md; run only safe checks against
   environments you are authorized to test.
9. Run the new tests and the surrounding suite with the project's commands. Run a
   new e2e test several times locally to expose flakiness.
10. Hand off: tests added or changed, commands with results, flake runs, artifacts
    (traces, reports) locations, gaps, and anything that needs an owner decision.

## Constraints

- Follow the project's existing test stack and conventions first. Playwright,
  Cypress, Vitest, Jest, Testing Library, axe, k6, or Lighthouse are examples, not
  recommendations.
- Do not add test frameworks, browsers, plugins, or services without the owner's
  decision. No auto-install; if a browser binary or tool is missing, report it.
- Never load-test, scan, or probe production or third-party systems without
  explicit written authorization from the owner.
- Never use real credentials or personal data; use test accounts and synthetic data.
- Do not weaken assertions, add retries, or skip tests to make a suite pass; a flaky
  or failing test goes to bug-loop.
- Do not update snapshots or baselines without checking that the new output is the
  intended behavior.
- Stay inside owned paths. Editing CI configuration is out of scope unless assigned.

## Verification

- New tests fail without the behavior they cover (or when it is broken) and pass
  with it.
- New e2e tests pass on repeated runs (for example three to five) without retries.
- The surrounding suite still passes with the project's command.
- No fixed sleeps, order dependence, or real secrets in the new tests.
- Performance results include baseline, conditions, and the target environment.

## Failure handling

- Tool or browser missing, or the app cannot start here: report the exact command
  and error; do not claim the tests ran.
- A test is flaky: capture a trace or log, then switch to bug-loop for the cause.
- A test reveals a product bug: report it with the reproduction; do not change the
  test to match buggy behavior.
- Authorization for a load or security target is unclear: stop and route upward.

## References

- [references/e2e.md](references/e2e.md) — read when writing or stabilizing browser end-to-end tests (steps 2-5).
- [references/unit-and-component.md](references/unit-and-component.md) — read when writing unit or component tests, mocks, or snapshots (steps 2-6).
- [references/performance-testing.md](references/performance-testing.md) — read when running performance baselines, budgets, or load tests (step 7).
- [references/security-testing.md](references/security-testing.md) — read when running dependency audits, header checks, or auth flow tests (step 8).
