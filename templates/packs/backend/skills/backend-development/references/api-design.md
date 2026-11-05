# API Design

Read when designing a new resource or endpoint, or choosing status codes,
pagination, idempotency, versioning, or request validation.

The project's existing API style wins. If it uses RPC-style routes, GraphQL, or
gRPC, apply the intent of these rules (clear resources, stable contracts, explicit
errors) in that style instead of converting it to REST.

## Resources and routes

- Name resources as plural nouns: `/orders`, `/orders/{id}`, `/orders/{id}/items`.
- Nest only for true ownership, at most one or two levels deep.
- Use methods for intent: GET reads (safe), PUT replaces (idempotent), PATCH
  partially updates, POST creates or runs an action, DELETE removes (idempotent).
- Model a non-CRUD action as a sub-resource or a POST to a named action
  (`POST /orders/{id}/cancel`) when the project already does so.
- Keep field naming consistent with existing responses (camelCase vs snake_case).
- Return the created or updated representation, or follow the existing convention.
- Use opaque or non-sequential IDs in URLs when enumeration would leak information.

## Status codes

| Situation | Code |
| --- | --- |
| Read or update succeeded | 200 |
| Created | 201, with a Location header if the project uses them |
| Accepted for async processing | 202, with a way to poll status |
| Success with no body | 204 |
| Malformed or invalid input | 400 or 422, following project convention |
| Not authenticated | 401 |
| Authenticated but not allowed | 403, or 404 to avoid revealing existence |
| Not found | 404 |
| State conflict, duplicate, version mismatch | 409 (or 412 for preconditions) |
| Rate limited | 429, with Retry-After when known |
| Unexpected server failure | 500 |
| Dependency unavailable or timed out | 502, 503, or 504 |

Never return 200 with an error body. Never return 500 for invalid client input.

## Error body

Use one error shape everywhere. If the project has none, a stable machine-readable
code, a human message, and optional field details is enough, for example
`{ "error": { "code": "validation_failed", "message": "...", "fields": {...} } }`.
Some projects use RFC 9457 problem details; follow what exists.

## Pagination

- Cursor (keyset) pagination for large or changing collections: return an opaque
  `next` cursor derived from the sort key plus a unique tiebreaker.
- Offset pagination only for small, stable sets or when the client needs page
  numbers; it slows down and skips or repeats rows under concurrent writes.
- Always cap the page size server-side and apply a default.
- Make the sort order explicit and deterministic.
- Return total counts only when cheap or required; counting can be costly.

## Filtering and sorting

- Whitelist filterable and sortable fields; never pass raw input into a query.
- Reject unknown filter or sort parameters, or ignore them, per project convention.

## Idempotency

- PUT and DELETE must be idempotent by design.
- For POST that creates or charges, accept an idempotency key header when clients
  may retry. Store the key with the request fingerprint and the response; replay the
  stored response on repeat; reject a reused key with a different body (409 or 422).
- Give stored keys an expiry. Scope them per client or user.
- Webhook and job handlers dedupe on the event or message ID.

## Concurrency

- For updates that can race, use optimistic concurrency: an ETag or version field,
  with If-Match or a version in the body, and 409 or 412 on mismatch.

## Versioning

- Prefer additive, backward-compatible change: new optional fields, new endpoints.
- Breaking changes (removing or renaming fields, changing types or meaning,
  tightening validation) need the owner's decision and a migration path.
- Follow the project's versioning scheme (path prefix, header, or none). Do not
  introduce a scheme without a decision.
- Clients should ignore unknown fields; do not rely on field order.

## Request validation

- Validate at the boundary: types, required fields, ranges, lengths, formats,
  enum membership, and maximum body size.
- Use the project's existing validator or schema library; do not add another.
- Parse into a typed or normalized value, then pass only that value inward.
- Reject unknown fields when mass assignment is a risk (for example a client setting
  `role` or `ownerId`); never bind request bodies straight onto persistence models.
- Return all field errors at once where practical.
- Validation is not authorization; check permissions separately.
