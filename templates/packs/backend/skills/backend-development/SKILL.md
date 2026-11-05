---
name: backend-development
description: "Build server-side features in the project's existing stack: API endpoints, service logic, auth integration, error handling, and background jobs. Use when adding or changing handlers, services, permission checks, outbound calls, or jobs. Not for schema design or migrations (databases) or deployment and infrastructure (devops)."
---

# Backend Development

## When to use

- Adding or changing an HTTP or RPC endpoint, a service, or domain logic.
- Wiring authentication or authorization into a request path.
- Shaping errors, retries, timeouts, and logs in server code.
- Adding a background job, queue consumer, webhook receiver, or scheduled task.
- A read-only advisor or reviewer is asked whether backend code is sound (advice only).

## Not for

- Schema design, migrations, indexes, or slow queries: use databases.
- Deployment, containers, CI/CD, or infrastructure: use devops.
- Deciding what to test across a change: use test-strategy.
- A failing test or regression: use bug-loop.
- A security audit of a change: use security-review.
- Choosing a new framework, language, or architecture style: owner decision.

## Prerequisites

- The brief's owned paths and acceptance criteria; ALP.md and project instructions.
- The actual stack, read from manifests, lockfiles, and config (for example
  `package.json` for Node/TypeScript, `pyproject.toml` for Python, `go.mod` for Go).
  Do not infer the stack from folder names.
- One or two existing endpoints or services similar to the task. They define the
  conventions for routing, validation, errors, logging, and tests.
- The project's lint, typecheck, and test commands and how they run locally.

## Workflow

1. Restate the contract: inputs, outputs, error cases, who may call it, and side
   effects. Product rules the brief leaves open go upward; do not guess them.
2. Locate the seams: transport (routing, parsing, status codes), service or domain
   logic, data access. Follow the existing layering; keep transport details out of
   service code.
3. Shape the interface in the project's existing API style. Read api-design.md for
   new resources, pagination, idempotency, versioning, or validation rules.
4. Validate input at the boundary with the project's existing validation approach.
   Reject malformed or unknown input with a clear client error.
5. Authenticate once at the edge; authorize per resource where the resource is
   loaded. Read authentication.md when touching login, sessions, tokens, or roles.
6. Implement service logic as small units with explicit dependencies (data store,
   clients, clock, config) so tests can substitute them.
7. Handle failure deliberately: map domain errors to responses in one place, put a
   timeout on every outbound call, retry only idempotent work. Read error-handling.md.
8. For background work: make handlers safe to run twice, bound retries with backoff,
   record a terminal failure state, enqueue only after the data commit, and never
   hold a transaction open across an external call.
9. Add tests at the seams the change affects. Read testing.md.
10. Run the project's lint, typecheck, and tests. Exercise the endpoint once against
    a local or test server when the environment allows.
11. Hand off: files changed, contract summary, commands run with results, schema or
    config changes needed (and who owns them), and open decisions.

A read-only agent runs steps 1-3 and reviews 4-8 against the code or proposal, then
reports findings and a recommended change instead of editing.

## Constraints

- Follow the project's existing stack and conventions first. Express, Fastify,
  NestJS, FastAPI, Django, Flask, or Go net/http are examples, not recommendations.
- Do not add dependencies, frameworks, or services without the owner's decision.
  No auto-install. If a library would help, propose it with the reason and route up.
- Never hardcode secrets or read secret values; use the project's config mechanism
  and documented example config. Never log tokens, passwords, or full personal data.
- Do not change a public contract (field names, status codes, error shapes) without
  the owner's decision; prefer additive changes.
- Schema changes go to whoever owns migrations, described with the databases skill.
- Stay inside owned paths. The skill grants no authority to push, release, deploy,
  or edit CI.

## Verification

- Project lint, typecheck, and tests pass on the final tree.
- New tests fail without the change and pass with it.
- Every error case in the contract has a test or a stated reason it has none.
- The authorization-denied path is tested (wrong user or missing role).
- No secrets, tokens, or real personal data in code, logs, fixtures, or snapshots.
- The request was exercised end to end once, or the handoff says why it was not.

## Failure handling

- Tests cannot run (missing database, service, or credential): report the exact gap
  and what was verified instead. Do not mock away the behavior under change.
- Conventions conflict or are missing: follow the nearest established pattern and
  note the inconsistency. Do not refactor unrelated code.
- An unexpected failure or regression appears: switch to bug-loop.
- An ambiguity affects behavior, data, or security: stop that part and route upward.

## References

- [references/api-design.md](references/api-design.md) — read when designing a new resource or endpoint, or choosing status codes, pagination, idempotency, versioning, or validation (step 3).
- [references/authentication.md](references/authentication.md) — read when touching login, sessions, tokens, OAuth/OIDC, password storage, or permission checks (step 5).
- [references/error-handling.md](references/error-handling.md) — read when mapping errors to responses, adding retries or timeouts, or deciding what to log (step 7).
- [references/testing.md](references/testing.md) — read when choosing handler, service, integration, or contract tests (step 9).
