# End-to-End Tests

Read when writing or stabilizing browser end-to-end tests.

Examples use Playwright-style APIs; Cypress and WebDriver-based tools have
equivalents. Use the project's runner, config, and helpers.

## Scope

- Keep e2e tests few and focused on critical user journeys: sign in, the main
  create/read/update flow, checkout or submission, permission boundaries.
- Push edge cases and validation variants down to component or unit tests.
- One test proves one journey; avoid giant scripts that test everything in order.

## Selectors

Prefer selectors a user would recognize, in this order:

1. Role with accessible name: `getByRole('button', { name: 'Save' })`.
2. Label: `getByLabel('Email')`.
3. Visible text or placeholder for non-interactive content.
4. A dedicated test ID (`data-testid`) when no accessible handle exists, per the
   project's convention.

Avoid CSS classes, DOM structure, nth-child, and XPath; they break on markup
changes. A missing accessible name is often a real accessibility bug; report it.

## Waiting, never sleeping

- Never use fixed sleeps (`waitForTimeout`, `sleep`) to synchronize.
- Use auto-waiting actions and web-first assertions that retry until a condition
  holds (`expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`).
- Wait on the specific network response or UI state the next step depends on.
- Keep timeouts at the project's defaults; raising a timeout to pass a test hides a
  slow or broken path.

## Isolation

- Each test creates or seeds its own data (API calls, seed helpers, or fixtures)
  and does not rely on other tests or run order.
- Use a fresh browser context per test; reuse authenticated storage state from a
  setup step rather than logging in through the UI every time, if the project does.
- Use unique names (suffix with a run ID) to avoid collisions under parallel runs.
- Clean up created data when the environment is shared, or use a disposable
  environment.
- Do not share mutable module-level state between tests.

## External dependencies

- Stub third-party services (payments, email, maps, analytics) at the network layer
  or point them at sandbox modes the project already uses.
- Never send real email, SMS, or payments from tests.
- Control time and randomness where the app supports it (clock mocking, seeded data).

## Assertions

- Assert user-visible outcomes: text, URL, enabled state, a row appearing.
- Assert the absence of error toasts or console errors when the project does so.
- Avoid asserting exact pixel layout in functional tests; that is visual testing.

## Visual and accessibility checks

- Visual snapshots: stable viewport, fonts, and data; mask dynamic regions (dates,
  avatars); disable animations. Review every snapshot diff before accepting it.
- Snapshots differ across OS and browser builds; generate baselines in the same
  environment CI uses.
- Accessibility scans (axe-style) on key pages and states, including open dialogs.
  Treat them as a floor, not proof of accessibility.

## Debugging and traces

- Enable traces, screenshots, or video on failure or first retry, per project config.
- Read the trace before changing the test: locate the step, the DOM state, and the
  network calls at failure.
- Reproduce a flake with repeated runs (`--repeat-each` or equivalent) and with
  parallel workers; record the failure rate.
- Retries in CI may exist as policy; a test that needs them is still flaky and goes
  to bug-loop.

## Running

- Run against a local server or preview build started the way the project does
  (the runner's web-server config or a script).
- Run headless in CI and headed or with the inspector locally when debugging.
- Run the browsers the project targets; do not add browsers without a decision.
