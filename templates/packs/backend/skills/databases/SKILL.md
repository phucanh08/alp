---
name: databases
description: "Design schemas, write safe migrations and backfills, and tune queries for relational databases (PostgreSQL, MySQL, SQLite) and document stores, using the project's existing tooling. Use when adding tables or collections, changing constraints or indexes, migrating data, or fixing slow queries. Not for API or service logic (backend-development)."
---

# Databases

## When to use

- Adding or changing tables, columns, collections, constraints, or indexes.
- Writing a schema migration, data backfill, or rollback plan.
- Diagnosing a slow query, N+1 pattern, lock wait, or deadlock.
- Choosing a transaction boundary or isolation level for a data operation.
- A read-only advisor or reviewer is asked to assess a schema or migration (advice only).

## Not for

- Endpoints, service logic, auth, or error mapping: use backend-development.
- Provisioning, backups, replication, or database hosting: use devops.
- A failing test or data regression with unknown cause: use bug-loop.
- Picking a new database engine, ORM, or migration tool: owner decision.

## Prerequisites

- The brief's owned paths and acceptance criteria; ALP.md and project instructions.
- The engine and major version, the ORM or query layer, and the migration tool, read
  from manifests, config, and the existing migrations directory.
- The existing migration conventions: naming, ordering, up/down or forward-only,
  how migrations run in tests and deploys.
- A local or test database to run against. Never a shared or production database.

## Workflow

1. State the data requirement: entities, relationships, cardinality, required
   fields, uniqueness, retention, and the main read and write paths.
2. Read the current schema (migrations, models, or a dump of a test database), not
   only the ORM models; they can drift.
3. Design the change. Put integrity rules in the database where the engine supports
   them: NOT NULL, foreign keys, unique, check constraints. Read
   schema-and-migrations.md.
4. Plan rollout for a table with live data: expand, migrate data, switch code,
   contract. Each step must be safe with both the old and new application version
   running.
5. Assess locking: will the statement rewrite the table or hold a strong lock? Use
   the engine's online form (for example concurrent index builds in PostgreSQL) and a
   lock timeout when the project's tool allows it.
6. Write the migration with the project's tool. Make it reversible, or record why it
   is forward-only and how to recover.
7. Write backfills as separate, batched, resumable steps, not inside the schema
   migration when the table is large.
8. For query work, measure first: capture the query, its parameters, and the plan.
   Read query-performance.md. Change one thing, re-measure on comparable data.
9. Run migrations up, down (if supported), and up again on a test database, then
   the project's tests.
10. Hand off: migration files, rollout order, lock and runtime estimate, backfill
    plan, rollback path, plans before and after for query changes, open decisions.

A read-only agent runs steps 1-5 and 8 against the proposal or current schema, then
reports risks and a recommended design instead of editing.

## Constraints

- Follow the project's existing engine, ORM, migration tool, and naming first.
  Prisma, Drizzle, SQLAlchemy/Alembic, Django migrations, golang-migrate, or plain SQL
  files are examples, not recommendations.
- Do not add dependencies, extensions, or new data stores without the owner's
  decision. No auto-install.
- Never run migrations, backfills, or ad hoc writes against shared, staging, or
  production databases; that is a deploy step for whoever owns it.
- Never edit a migration that has already been applied outside your local database;
  add a new one.
- Destructive changes (dropping or renaming columns or tables, narrowing types,
  deleting data) need the owner's explicit decision and a recorded rollback plan.
- Do not read credentials or real personal data; use test data and example config.
- Stay inside owned paths. The skill grants no authority to deploy or release.

## Verification

- Migration applies cleanly to an empty database and to one with representative data.
- Down migration (if supported) restores the prior schema; up applies again.
- The project's tests pass with the new schema.
- Constraints reject the invalid data they are meant to reject (a test proves it).
- For performance changes: before and after plans and timings on comparable data,
  with the conditions recorded.
- Rollout steps are each compatible with the running application version.

## Failure handling

- Migration fails on existing data: stop, report the violating rows' pattern (not
  their contents), and propose a cleanup step or a staged constraint.
- A lock or long rewrite is unavoidable: report the estimate and route the
  maintenance-window decision upward.
- No test database is available: report the gap; do not claim the migration ran.
- Plans differ between local and production-like data: say so; do not generalize.
- An ORM model and the real schema disagree: report the drift before changing either.

## References

- [references/schema-and-migrations.md](references/schema-and-migrations.md) — read when designing tables, constraints, or document shapes, or planning expand/contract migrations, backfills, reversibility, or lock risk (steps 3-7).
- [references/query-performance.md](references/query-performance.md) — read when adding indexes, reading EXPLAIN output, fixing N+1, paginating, or choosing transactions and isolation (step 8).
