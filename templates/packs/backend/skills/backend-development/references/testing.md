# Backend Testing

Read when choosing handler, service, integration, or contract tests for a backend
change. What to test overall belongs to test-strategy; this covers how at each seam.

Use the project's existing test runner, fixtures, and helpers (for example Jest or
Vitest for Node/TypeScript, pytest for Python, `go test` for Go). Do not add a test
framework or container tool without the owner's decision.

## Choose the seam

| Seam | Proves | Substitute |
| --- | --- | --- |
| Service / domain unit | business rules, edge cases, error mapping | fakes for store, clock, clients |
| Handler / route | parsing, validation, status codes, auth wiring, error shape | in-process server; service real or faked |
| Integration | queries, transactions, constraints, migrations | real database of the same engine |
| Contract | request and response shape agreed with a consumer or provider | recorded or schema-based contract |
| End to end | a critical flow across processes | test environment only |

Put most cases at the cheapest seam that still exercises the real cause. A query
bug needs the real database engine; a validation rule does not.

## Service tests

- Inject dependencies (store, clock, ID generator, outbound clients) so tests control
  them. A hand-written fake with real behavior beats a mock that only records calls.
- Cover each contract case: success, each domain error, boundary values, and
  idempotent replay.
- Freeze time and randomness rather than sleeping or asserting ranges.

## Handler tests

- Drive the handler through the framework's in-process test client (for example
  supertest-style requests, FastAPI or Django test clients, `httptest` in Go).
- Assert status, the error code, and the important body fields; avoid asserting the
  whole body when only a few fields are contractual.
- Test authentication and authorization paths: missing credentials, wrong user,
  wrong tenant, sufficient role.
- Test validation failures, including oversized and unknown fields.

## Integration tests with a real database

- Use the same engine and major version as production. SQLite does not stand in for
  PostgreSQL or MySQL behavior (types, locking, constraint errors).
- Run it the way the project already does: a test container, a local service, or a
  CI service. If none exists, propose one; do not install it.
- Apply the real migrations to the test database, not a hand-written schema.
- Isolate tests: a transaction rolled back per test, a fresh schema per worker, or
  truncation between tests. Do not depend on test order.
- Seed only the data a test needs, via factories or builders, inside the test.
- Never point tests at a shared or production database.

## Outbound dependencies

- Fake third-party HTTP at the client boundary (a local stub server or the
  project's HTTP mocking tool). Do not call real external services in tests.
- Test timeout and error responses from the dependency, not only success.
- Use test credentials or dummy values; never real keys.

## Background jobs

- Run the handler directly with a message; assert the effect.
- Run it twice with the same message; assert no duplicate effect.
- Make the handler fail; assert the retry count and the terminal failure state.

## Contract tests

- When another team or service consumes the API, verify the shape against the
  agreed schema (OpenAPI, protobuf, JSON Schema) or consumer contracts, using the
  project's existing tool.
- A contract test failing on your change means a breaking change; route the
  decision upward rather than updating the contract to pass.

## Hygiene

- No sleeps for synchronization; wait on a condition or use a controllable clock.
- No real secrets, personal data, or production dumps in fixtures.
- A new test must fail without the change. If it passes before the fix, it does not
  prove the change (see bug-loop).
- Keep test runtime proportional; mark slow integration tests the way the project
  already does.
