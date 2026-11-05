# Unit and Component Tests

Read when writing unit or component tests, mocks, or snapshots for web code.

Examples use Vitest or Jest with Testing Library-style queries; Vue Test Utils,
Svelte Testing Library, and Angular TestBed have equivalents. Use the project's
runner, environment (jsdom, happy-dom, or a real browser mode), and setup files.

## Unit tests

- Target pure logic: formatting, parsing, validation, reducers, state machines,
  selectors, utility functions.
- Table-driven cases for input variants; include boundaries, empty values, and
  invalid input.
- No DOM or network needed; if a unit test needs many mocks, the code may need a
  seam, or the test belongs at a different level.
- Control time and randomness with the runner's fake timers or injected clocks;
  restore them after each test.

## Component tests

- Render the component with realistic props and the providers it needs (router,
  theme, query client, i18n) through a shared test helper if the project has one.
- Interact like a user: user-event style typing, clicking, and keyboard actions
  rather than firing synthetic low-level events.
- Query by role, label, and text; use test IDs only when nothing accessible exists.
- Assert what the user sees or what the component emits, not internal state,
  instance methods, or private hooks.
- Cover each visible state: loading, empty, error, success, disabled, and validation
  errors.
- Use async queries (`findBy...`, `waitFor`) for asynchronous updates; never fixed
  delays.

## Mocking

- Mock at boundaries: the network (request-level mocking such as MSW-style handlers
  or the project's tool), timers, browser APIs missing from the test environment.
- Prefer one realistic mock of the HTTP layer over mocking each module the component
  imports.
- Do not mock the unit under test or the framework itself.
- Reset mocks and handlers between tests; unexpected unhandled requests should fail
  the test.
- Keep mock data close to real API shapes, ideally from shared types or fixtures.

## Snapshots

- Avoid large DOM snapshots; they break on unrelated markup changes and get
  accepted without review.
- Use small inline snapshots for stable serialized output (a formatted string, a
  generated config).
- Review every snapshot change as a behavior change before updating it.

## Isolation and hygiene

- Each test sets up its own state; no order dependence.
- Clean up rendered components, timers, and global mutations (the runner usually
  auto-cleans; verify for custom setups).
- No real network, filesystem writes outside temp dirs, or real secrets.
- Keep tests fast; slow suites get skipped. Mark slow tests the way the project does.

## Coverage

- Use coverage reports to find untested branches in changed code, not as a target to
  hit. Do not add assertion-free tests to raise numbers.

## Environment caveats

- jsdom and similar environments lack layout, real CSS, and some APIs
  (IntersectionObserver, ResizeObserver, matchMedia); stub them in setup or test
  layout-dependent behavior in a real browser (e2e or browser mode).
- Server components or framework loaders may need the framework's own test
  utilities or an e2e test; check the framework docs for the installed version.

## Accessibility in component tests

- Role-based queries already catch missing names and roles.
- If the project uses an axe-style matcher, run it on rendered states with dialogs
  and menus open.
