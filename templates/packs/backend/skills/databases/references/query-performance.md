# Query Performance

Read when adding indexes, reading EXPLAIN output, fixing N+1, paginating, or
choosing transactions and isolation.

Measure before changing anything. Capture the exact query with its parameters (the
ORM's query log or the database's slow-query log in a test environment), the row
counts involved, and the plan. Re-measure on comparable data after each change.

## Reading plans

- PostgreSQL: `EXPLAIN (ANALYZE, BUFFERS)`; MySQL: `EXPLAIN ANALYZE` (8.0.18+) or
  `EXPLAIN FORMAT=TREE`; SQLite: `EXPLAIN QUERY PLAN`. ANALYZE executes the query:
  run it only on a test database, and wrap writes in a rolled-back transaction.
- Look for: sequential or full scans on large tables, estimated rows far from actual
  rows (stale statistics), sorts or hashes spilling to disk, nested loops over large
  inputs, and filters applied after fetching many rows.
- Plans depend on data volume and statistics. A plan on ten rows tells little; use
  representative volume or say the result is provisional.

## Indexes

- Index columns used in selective WHERE, JOIN, and ORDER BY clauses on large tables.
- Composite index order: equality columns first, then range or sort columns. An
  index on (a, b) serves filters on a, or a and b, not b alone.
- A covering index (including selected columns) can avoid table lookups for hot
  reads.
- Partial or filtered indexes suit queries over a small subset (`WHERE deleted_at IS
  NULL`).
- Functions on a column (`lower(email)`) defeat a plain index; use an expression
  index or store a normalized column.
- Leading wildcards (`LIKE '%x'`) cannot use a B-tree index; full-text search is an
  owner decision if needed.
- Every index slows writes and uses storage. Remove unused or duplicate indexes only
  with evidence of no use.
- Document stores: create indexes matching the query shape and sort; check the
  explain output for collection scans.

## N+1 queries

- Symptom: one query for a list, then one per item. Find it in query logs or by
  counting queries in a test.
- Fix with the ORM's eager loading or a batched `WHERE id IN (...)` query; in GraphQL
  or similar resolvers, a per-request batching loader.
- Add a test that asserts the query count for the endpoint when the project has a
  helper for it.
- Do not over-fetch: load only the columns and relations the caller uses.

## Pagination

- Keyset pagination: `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC,
  id DESC LIMIT $n`, backed by an index on the same columns. Constant cost per page.
- OFFSET scans and discards skipped rows; cost grows with depth. Acceptable for small
  sets.
- Always include a unique tiebreaker in the sort.
- Exact `COUNT(*)` on large tables is expensive; use an estimate or omit it when the
  product allows.

## Transactions

- Keep transactions short. No network calls, user waits, or large loops inside.
- Group writes that must succeed or fail together; nothing else.
- Lock rows in a consistent order across code paths to avoid deadlocks; retry on
  deadlock or serialization errors a bounded number of times.
- Use `SELECT ... FOR UPDATE` (or `SKIP LOCKED` for job queues) only where you must
  serialize access to specific rows.
- Long-running transactions block vacuum (PostgreSQL) and hold locks; watch for them
  in batch jobs.

## Isolation levels

| Level | Prevents | Watch for |
| --- | --- | --- |
| Read committed (PostgreSQL default) | dirty reads | non-repeatable reads, lost updates |
| Repeatable read (MySQL InnoDB default) | non-repeatable reads | write skew; MySQL gap locks |
| Serializable | all anomalies | serialization failures that must be retried |

- For read-modify-write, prefer an atomic update (`SET n = n + 1`), a conditional
  update with a version check, or a row lock over raising isolation globally.
- SQLite serializes writers; long write transactions block other writers.

## Other checks

- Use parameterized queries always; they also enable plan reuse.
- Connection pool size should fit the database's limits; more connections can be
  slower.
- Avoid `SELECT *` on wide tables in hot paths.
- Cache only with a stated invalidation rule and the owner's agreement.
