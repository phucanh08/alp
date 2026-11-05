# Components and State

Read when splitting components, choosing where state lives, or handling forms.

Examples use React terms; the same ideas map to Vue (props, emits, refs, computed,
composables) and Svelte (props, stores, runes or reactive statements). Follow the
project's existing patterns and file layout.

## Component structure

- One component, one job. Split when a part has its own state, is reused, or makes
  the parent hard to read; do not split only to shorten a file.
- Separate data-loading containers from presentational components when the project
  does; presentational components take props and are easy to test.
- Props flow down, events flow up. Name callbacks for intent (`onSubmit`,
  `onSelect`), not for the DOM event.
- Prefer composition (children, slots) over many boolean props that toggle layout.
- Keep components pure during render: no fetching, subscriptions, or mutations in
  the render body; use the framework's effect or lifecycle mechanism.
- Use stable keys from data IDs in lists, never array indexes for reorderable lists.
- Extract reusable logic into hooks or composables only once a second use exists.

## Where state lives

Choose the narrowest home that works:

| Kind | Home |
| --- | --- |
| Value only one component uses | local component state |
| Value shared by siblings | lift to nearest common parent |
| Value derivable from other state or props | compute it; do not store it |
| Server data | the project's data-fetching cache, not global state |
| URL-worthy (filters, tab, page, selected ID) | route params or query string |
| Form input | form state (local or the project's form library) |
| Truly app-wide (theme, session, locale) | context or the project's store |

- Duplicated state drifts. If two places hold the same fact, keep one source and
  derive the other.
- Avoid syncing state with effects (`useEffect` that copies props to state); derive
  during render or reset with a key.
- Context re-renders all consumers on change; split contexts or use a store if a
  frequently changing value is shared widely.
- Put state that should survive reload or be shareable in the URL.
- Do not add a global store library without the owner's decision.

## Effects and lifecycle

- Use effects to synchronize with something external (subscription, timer, DOM
  API), not to compute values or respond to user events.
- Every subscription, listener, timer, or observer gets cleaned up.
- Handle strict-mode double invocation in development: effects must be safe to run,
  clean up, and run again.

## Forms

- Use the project's form approach (native form, controlled inputs, or its form
  library) consistently.
- Every input has a label. Show validation errors next to the field and summarize
  on submit; move focus to the first error.
- Validate on the client for feedback; the server remains the authority.
- Disable or guard the submit action while pending to prevent double submission;
  show progress.
- Keep entered data on a failed submit.
- Treat the server's validation response as the source of field errors.

## Typing and contracts

- Type props and events with the project's type system (TypeScript, PropTypes, or
  framework-specific types).
- Share API response types with the backend only through the project's existing
  mechanism (generated types, shared package); do not hand-copy drifting types.
- Narrow nullable data at the boundary so components receive complete values or an
  explicit empty state.

## Styling

- Use the project's styling system (CSS modules, utility classes, CSS-in-JS, scoped
  styles) and design tokens. Do not mix in a second approach.
- Avoid inline magic values for spacing and color when tokens exist.
