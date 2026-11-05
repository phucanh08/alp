# Schema and Migrations

Read when designing tables, constraints, or document shapes, or planning
expand/contract migrations, backfills, reversibility, or lock risk.

## Normalization trade-offs

- Start normalized (roughly third normal form): each fact stored once, related by
  keys. It keeps writes simple and prevents update anomalies.
- Denormalize only for a measured read need: a counter, a cached aggregate, a copied
  field to avoid a hot join. Record who keeps the copy in sync (trigger, same
  transaction, or job) and how drift is detected.
- Use JSON columns for genuinely schemaless or sparse attributes, not to avoid
  designing columns that are queried, filtered, or constrained.
- Document stores: shape documents around the access pattern. Embed data read
  together and bounded in size; reference data that is shared, large, or unbounded
  (arrays that grow without limit hurt). Plan a schema version field when shapes
  will evolve.

## Keys and types

- One primary key per table; follow the project's ID style (bigint identity,
  UUID/ULID). Random UUIDv4 keys fragment B-tree indexes on large tables; time-
  ordered IDs avoid that where the project allows.
- Use precise types: decimal or integer minor units for money, timestamps with time
  zone (or UTC by convention), enums or check constraints for closed sets, text with
  a length check rather than arbitrary varchar limits.
- Store times in UTC; convert at the edges.

## Constraints

- NOT NULL by default; nullable only when absence has meaning.
- Foreign keys for relationships, with an explicit ON DELETE behavior chosen on
  purpose (restrict, cascade, set null).
- Unique constraints for business uniqueness (email per tenant), not only app checks;
  app-level checks race.
- Check constraints for value rules the engine can enforce.
- SQLite: foreign keys need enabling per connection; many ALTER operations require
  a table rebuild. MySQL: check constraints are enforced only from 8.0.16.
- Name constraints and indexes consistently so later migrations can reference them.

## Expand and contract

Change a live schema in steps, each compatible with both old and new app versions:

1. Expand: add the new column, table, or index. Nullable or with a safe default.
2. Write both: deploy code that writes old and new shapes.
3. Backfill existing rows into the new shape.
4. Read new: switch reads; verify.
5. Contract: stop writing the old shape, then drop it in a later migration.

Renaming a column in place breaks the running version; use add-copy-switch-drop.
Adding NOT NULL to an existing column: add a check or validate in a separate step
after the backfill, then set NOT NULL.

## Backfills

- Separate from the schema migration for large tables.
- Batch by primary key range or keyset (for example 1k-10k rows per batch), commit
  per batch, pause between batches if load matters.
- Idempotent and resumable: select only rows still needing the change.
- Log progress counts, not row contents.
- Verify: count remaining rows needing change equals zero.

## Reversible migrations

- Provide a down step when the tool supports it and the change can be undone.
- Data-destroying changes cannot be truly reversed; the rollback plan is restore or
  a retained copy. Say so explicitly.
- Keep each migration small and single-purpose; do not mix schema and large data
  changes.
- Never edit an applied migration; add a new one.

## Locking risks

| Operation | Risk | Safer form |
| --- | --- | --- |
| Create index (PostgreSQL) | blocks writes | `CREATE INDEX CONCURRENTLY` outside a transaction |
| Create index (MySQL InnoDB) | usually online | confirm `ALGORITHM=INPLACE, LOCK=NONE` |
| Add column with volatile default | table rewrite | add nullable, backfill, then default |
| Change column type | often rewrite | new column, backfill, swap |
| Add foreign key / check on big table | full scan under lock | PostgreSQL: `NOT VALID`, then `VALIDATE` |
| Add NOT NULL | scan under lock | validated check constraint first |

- Set a lock timeout (for example `SET lock_timeout` in PostgreSQL) so a migration
  waiting behind a long transaction fails fast instead of blocking all traffic.
- Behavior differs by engine and version; check the docs for the version in use.
