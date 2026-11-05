# Error Handling

Read when mapping errors to responses, adding retries or timeouts, or deciding
what to log.

## Error taxonomy

Classify every failure before deciding how to handle it.

| Class | Examples | Handling | Typical response |
| --- | --- | --- | --- |
| Invalid input | bad type, missing field | reject at boundary | 400/422 |
| Unauthenticated / forbidden | missing token, wrong owner | reject, no detail leak | 401/403/404 |
| Not found | unknown ID | domain error | 404 |
| Conflict | duplicate, stale version, invalid state transition | domain error | 409/412 |
| Rate or quota | client over limit | reject with hint | 429 |
| Transient dependency | timeout, connection reset, 503 upstream | retry if idempotent, else surface | 502/503/504 |
| Permanent dependency | 4xx from upstream, bad config | do not retry; alert | 500/502 |
| Bug / invariant broken | null where impossible | fail fast, log with context | 500 |

- Represent expected domain failures as typed errors or result values, following the
  project's pattern (exceptions with codes, error values in Go, result types).
- Do not use exceptions for normal control flow where the project does not.
- Never swallow an error silently. Either handle it, wrap it with context and pass
  it up, or log it at the boundary where it ends.

## Mapping to responses

- Map errors to responses in one place (error middleware, exception handler, or a
  shared helper), not in every handler.
- Return the project's standard error shape with a stable code.
- Expose no internals: no stack traces, SQL, file paths, or upstream bodies.
- Include a request or correlation ID in the response and the logs so a report can be
  traced.
- Unknown errors become a generic 500 and are logged in full server-side.

## Timeouts

- Every outbound call (HTTP, database, cache, queue) has a timeout. Use the client's
  configured default if the project has one; otherwise propose a value.
- Propagate the request deadline or cancellation (context in Go, AbortSignal in
  Node, timeouts or task cancellation in Python) so work stops when the caller gave
  up.
- An inner timeout must be shorter than the outer one.

## Retries

- Retry only transient failures of idempotent operations, or operations made
  idempotent with a key.
- Bound attempts (small number), use exponential backoff with jitter, and respect
  Retry-After.
- Retry at one layer only; stacked retries multiply load.
- Do not retry validation, auth, or other permanent errors.
- For a dependency that keeps failing, use the project's circuit breaker or fallback
  if it has one; do not add a new library without a decision.
- Background jobs: after the last attempt, move to a failure state or dead-letter
  queue with the reason; do not loop forever.

## Partial failure

- Keep a database transaction short and local. Do not call external services inside
  it.
- When a database write and an external effect (message, email, payment) must both
  happen, use the project's outbox or a compensating step; note the gap if neither
  exists.
- Make handlers safe to replay.

## Logging without secrets

- Log at the boundary where an error is handled, once, with: error code, message,
  request ID, operation, relevant non-sensitive IDs, and the cause chain.
- Use the project's logger and structured fields; match existing levels (client
  errors usually info or warn, server errors error).
- Never log: passwords, tokens, API keys, session IDs, authorization headers, full
  card numbers, secrets from config, or full request bodies that may contain them.
- Mask or omit personal data (email, phone, address) unless the project's policy
  allows it.
- Check that error messages built from upstream responses do not echo credentials.
- Do not log at error level for expected client mistakes; it hides real incidents.

## Checks to add

- Each mapped error class returns its documented status and code.
- An unexpected exception returns a generic 500 without internal detail.
- A timed-out dependency produces the documented response within the deadline.
- Retry stops after the bound and does not retry permanent errors.
- Log output for a failing auth request contains no token or password.
