# Contract tests

Read when a change touches an API, protocol, CLI output, event, schema or file format that other code or users depend on.

## What a contract test proves
That a producer still emits, and a consumer still accepts, the agreed shape and
semantics: field names, types, required versus optional, status or exit codes, error
format, ordering guarantees and versioning rules. It does not prove business logic.

## Choosing the form
| Situation | Form |
|---|---|
| Schema exists (OpenAPI, JSON Schema, proto, SQL migration) | Validate real responses or records against the schema in tests |
| Consumer and provider in the same repository | Shared fixture: provider test produces it, consumer test reads it |
| Separate consumer teams or services | Consumer-driven contract: consumer states expectations, provider verifies them in its build |
| Text or file output (CLI, reports, generated files) | Golden file compared byte for byte, with a reviewed update path |
| Wire protocol or event stream | Recorded messages replayed against the parser and emitted by the producer |

Prefer the mechanism the project already uses; do not add a contract-testing framework
without approval routed to main.

## Golden files
- Store next to the test, named after the case; review them like code.
- Normalise only genuinely variable parts (timestamps, ids, absolute paths) with a
  documented, minimal rule.
- Update through an explicit command or flag, never automatically on failure.
- A golden diff in a change must be explained in the handoff.

## Backwards compatibility checks
- Additive changes (new optional field, new endpoint) must leave old fixtures passing.
- Removing or renaming a field, changing a type, tightening validation, changing a
  default or an error code is breaking: keep a test with the old fixture and confirm
  the planned deprecation or version bump with main.
- Readers should tolerate unknown fields if the contract says so; test it.
- Stored data: test that the new code reads data written by the previous version, and,
  where rollback is supported, that the old code reads data written by the new one.
- Versioned APIs: keep at least one test per supported version.

## Minimum set for a contract change
1. A fixture of the previous shape, still accepted (or a documented, approved break).
2. A fixture of the new shape, produced by the provider test.
3. The consumer test reading the new shape.
4. An error-shape case: invalid request or malformed message yields the documented error.
