---
name: frontend-development
description: "Build UI features in the project's component framework (React-first examples, also Vue or Svelte): component structure, state, data fetching, routing and SSR, performance, and accessibility. Use when adding or changing screens, components, forms, or client data flows. Not for visual design decisions (ui-design) or test tooling (web-testing)."
---

# Frontend Development

## When to use

- Adding or changing a page, route, component, form, or client-side data flow.
- Deciding where state lives or how a screen loads, caches, and refreshes data.
- Fixing a measured rendering, bundle, or loading performance problem.
- Making a UI keyboard and screen-reader usable.
- A read-only advisor or reviewer is asked to assess frontend code (advice only).

## Not for

- Layout, color, typography, or visual design choices: use ui-design.
- Test runners, e2e, visual, or load tooling: use web-testing.
- Deciding what to test across a change: use test-strategy.
- A failing test or UI regression with unknown cause: use bug-loop.
- Server endpoints behind the UI: use backend-development.
- Choosing a new framework, state library, or styling system: owner decision.

## Prerequisites

- The brief's owned paths and acceptance criteria; ALP.md and project instructions.
- The actual framework and version, router, data-fetching and state libraries,
  styling approach, and build tool, read from `package.json`, the lockfile, and
  config files. Do not infer from folder names.
- One or two existing screens or components similar to the task. They define the
  conventions for file layout, naming, data loading, styling, and tests.
- The design or acceptance spec for the UI, if one exists, and the project's
  existing design-system components.
- The project's dev, lint, typecheck, and test commands.

## Workflow

1. Restate the feature as user-visible states: loading, empty, error, success,
   partial, and permission-denied. Unspecified states go upward; do not invent copy
   or product behavior.
2. Find existing components, hooks, and utilities to reuse before writing new ones.
3. Sketch the component tree and decide where each piece of state lives. Read
   components-and-state.md.
4. Define data needs: which endpoint, when it loads, how it caches and refreshes,
   and what happens on failure or a stale response. Read data-fetching.md.
5. Place the work in the framework's model (server or client component, route
   loader, page, island). Read frameworks.md; check the docs for the version the
   project uses.
6. Build with semantic HTML and existing design-system components; wire keyboard
   and focus behavior as you go. Read accessibility.md.
7. Handle every state from step 1 in the UI, including disabled and pending states
   for actions and protection against double submit.
8. Check performance only where it matters: large lists, heavy components, new
   dependencies, images. Measure before optimizing. Read performance.md.
9. Add or update tests with the project's tooling (see web-testing for tool use).
10. Run lint, typecheck, and tests; open the page in the dev server and exercise
    each state, with keyboard only at least once.
11. Hand off: files changed, states covered, screenshots or notes if the project
    uses them, commands run with results, open design or product questions.

A read-only agent reviews steps 1-8 against the code or proposal and reports
findings and recommended changes instead of editing.

## Constraints

- Follow the project's existing framework, version, and conventions first. React,
  Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, or plain web components are
  examples, not recommendations.
- Do not add dependencies, UI kits, state or fetching libraries, or frameworks
  without the owner's decision. No auto-install.
- Use the project's design tokens and components; do not invent new visual styles.
  Visual gaps go to ui-design or upward.
- Never put secrets in client code or public env variables; anything shipped to the
  browser is public.
- Treat user content as untrusted: no raw HTML injection without the project's
  sanitizer.
- Stay inside owned paths. The skill grants no authority to deploy or release.

## Verification

- Lint, typecheck, and tests pass; the production build succeeds if the change
  touches routing, config, or imports.
- Each state from step 1 was seen in the running app or covered by a test.
- Keyboard-only use reaches and operates every new control; focus is visible.
- No new console errors or warnings in the dev server for the changed screens.
- Performance claims include before and after measurements.

## Failure handling

- The dev server or build cannot run here: report the exact error and what was
  verified instead; do not claim visual checks that were not done.
- Missing design or copy: use existing patterns as placeholders, mark them, and
  route the decision upward.
- Hydration or SSR mismatch, or a flaky render: switch to bug-loop.
- The API does not provide what the UI needs: report the gap to the owner of the
  backend; do not work around it with client-side data scraping.

## References

- [references/components-and-state.md](references/components-and-state.md) — read when splitting components, choosing where state lives, or handling forms (step 3).
- [references/data-fetching.md](references/data-fetching.md) — read when loading, caching, mutating, or refreshing server data, or handling races (step 4).
- [references/frameworks.md](references/frameworks.md) — read when choosing SSR, SSG, or CSR, server or client components, or routing placement (step 5).
- [references/accessibility.md](references/accessibility.md) — read when building interactive controls, forms, dialogs, or custom widgets (step 6).
- [references/performance.md](references/performance.md) — read when a screen is slow, a bundle grows, or images and lists are heavy (step 8).
