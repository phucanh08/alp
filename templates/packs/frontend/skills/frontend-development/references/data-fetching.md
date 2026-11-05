# Data Fetching

Read when loading, caching, mutating, or refreshing server data, or handling races.

Use the project's existing mechanism: framework loaders or server components, a
query-cache library (TanStack Query, SWR, Apollo, RTK Query are examples), or plain
fetch wrapped in a shared client. Do not add a second one.

## Every request has four states

- Loading: show a skeleton or spinner sized like the final content to avoid layout
  shift. For quick loads, delay the indicator briefly to avoid flashing.
- Error: show a useful message and a retry action. Distinguish "not found",
  "not allowed", "offline", and "server error" when the API allows. Do not show raw
  error objects or stack traces.
- Empty: a distinct state with guidance or an action, not a blank area.
- Success: render data; keep previous data visible during background refresh rather
  than flashing back to loading.

Also consider partial data (some sections failed) and stale data (shown while
refreshing).

## Where to fetch

- Prefer route-level or server-side loading when the framework supports it, so data
  starts loading with navigation and waterfalls are avoided.
- Start independent requests in parallel; do not chain them in nested components
  unless one depends on another.
- Do not fetch in render. In client components use the cache library or an effect
  with cleanup.
- Keep the API client in one module: base URL, auth headers or cookies, JSON
  parsing, and error normalization.

## Caching

- Key cached data by everything that affects the response (resource, ID, filters,
  page, user or tenant).
- Decide freshness per resource: how long data counts as fresh, and when to refetch
  (focus, reconnect, interval, explicit invalidation).
- Invalidate or update affected keys after a mutation; do not leave lists stale
  after a create or delete.
- Clear user-specific cache on logout or account switch.
- Respect HTTP caching headers the backend already sets; do not cache personalized
  responses in shared caches.

## Race conditions

- A slower earlier response must not overwrite a newer one. Cancel the previous
  request (AbortController or the library's cancellation) or ignore results whose
  key no longer matches the current input.
- Debounce search-as-you-type and cancel in-flight requests on new input.
- Ignore results after unmount; clean up subscriptions and abort in-flight requests.
- Guard against double submission of mutations: disable while pending, and send an
  idempotency key if the API supports it.

## Mutations

- Show pending state on the control that triggered the mutation.
- Optimistic updates only when failure is rare and reversible; roll back on error
  and tell the user.
- On validation errors from the server, map them to fields.
- After success, update or invalidate the cache, then move focus or announce the
  result for assistive technology.

## Errors and retries

- Retry automatically only idempotent reads, with a small bound and backoff. Do not
  auto-retry mutations unless they are idempotent.
- Handle 401 in one place (refresh or redirect to login per project convention).
- Use the framework's error boundary or error route for unexpected failures so one
  broken widget does not blank the page.
- Report errors through the project's existing monitoring, without personal data or
  tokens.

## Security

- Never embed secrets or private API keys in client code; route through the
  backend.
- Send credentials only to the project's own origins.
- Do not trust client-side checks for authorization; the server enforces it.

## Testing notes

- Mock the network at the HTTP layer (the project's request-mocking tool) rather
  than mocking the cache library internals.
- Test each of the four states and a slow-then-fast race for search inputs.
