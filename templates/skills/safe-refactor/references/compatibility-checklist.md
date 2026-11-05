# Compatibility Checklist

Read when a refactor touches anything visible outside the module being changed.

For each item that applies, record: what is exposed, who consumes it, how you
checked, and the result (unchanged / changed with approved decision / shimmed).

## Public API and exported symbols

- Names, signatures, parameter order, defaults, optional vs required arguments.
- Return types and shapes, including null/undefined and empty cases.
- Thrown error types, codes, and messages that callers match on.
- Sync vs async, callback vs promise, iteration order, laziness.
- Re-exports and package entry points (`exports` maps, index files, public headers).
- Type declarations shipped to consumers.

## Config formats

- Keys, nesting, types, defaults, and precedence between sources.
- Environment variable names and parsing.
- Behavior for unknown or missing keys; old keys still accepted.

## Persisted data

- On-disk files, database schemas, caches, and their serialization formats.
- Field names, enum values, IDs, and ordering that readers depend on.
- Data written by the old code must still be readable by the new code, and, if a
  rollback is possible, the reverse.

## CLI flags and output

- Flag names, aliases, short forms, argument order, exit codes.
- Machine-readable output (JSON, tab-separated) that scripts parse.
- Help text only if tests or docs assert it.

## Protocol and wire formats

- Message types, field names, versions, and negotiation.
- HTTP routes, methods, status codes, headers, and payloads.
- Events and their names, payloads, and ordering guarantees.

## Finding consumers

- Search for symbol names, string keys, file names, and route paths across the repo,
  including tests, scripts, docs, examples, and generated code.
- Check dynamic access: reflection, string-built imports, routing tables, plugin
  registries, serialization by field name.
- Consumers outside the repo (published packages, other services, user configs)
  cannot be searched: treat their surface as frozen unless a decision says otherwise.

## When something must change

- Prefer an additive change: keep the old name or format as a shim that delegates
  to the new one, with a deprecation note.
- If removal is required, stop and route the decision upward with the consumer list
  and a migration path. Record the approved decision in an ADR or task note.
