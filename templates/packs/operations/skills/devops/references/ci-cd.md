# CI/CD pipelines

Read when changing pipeline stages, caching, action or tool versions, tokens and permissions,
or build reproducibility.

## Stages

Typical order; keep the project's existing stage names and split:

1. Checkout and setup (pinned runtime and tool versions).
2. Install dependencies from the lockfile in frozen mode.
3. Static checks: format, lint, type check. Fast, fail early.
4. Tests: unit, then integration; heavier suites gated or parallelized.
5. Build artifacts and images, tagged with an immutable identifier.
6. Security and license checks the project already uses.
7. Publish artifacts (only on protected branches or tags).
8. Deploy to non-production automatically if the project does so; production behind a manual
   approval or protected environment.

- Each job does one thing and states its inputs and outputs.
- Fail fast: cheap checks before expensive ones; cancel superseded runs on the same branch.
- Required checks on the default branch match the jobs that actually run.

## Caching

- Cache dependency downloads keyed on the lockfile hash plus OS and runtime version.
- Cache build outputs only when the tool supports correct invalidation.
- Never cache secrets, credentials or deploy outputs.
- A cache is an optimization: the pipeline must pass with a cold cache. If it does not, the
  cache is hiding a bug.
- Watch cache size and restore time; an oversized cache can be slower than reinstalling.

## Pinning versions

- Pin third-party actions, orbs or plugins to a full commit SHA or an immutable version, with the
  human-readable version in a comment, following the project's convention.
- Pin runner images, language runtimes and CLI tools to explicit versions.
- Pin container base images used in jobs.
- Update pins deliberately (via the project's dependency update tool if it has one) and review
  the upstream changes.

## Least-privilege tokens

- Set the default token permissions to read-only at workflow level; grant write scopes per job
  only where needed (e.g. publishing packages, commenting on PRs).
- Prefer short-lived federated credentials (OIDC) to long-lived cloud keys where the platform
  supports it; scope trust to repository, branch and environment.
- Store secrets in the platform's secret store, scoped to environments; production secrets only
  in protected environments with required reviewers.
- Never echo secrets; avoid commands that print environment variables. Mask derived values.
- Workflows triggered by forks or untrusted PRs must not receive secrets or write tokens. Be
  careful with triggers that run with elevated privileges on PR content.
- Treat PR titles, branch names and commit messages as untrusted input; do not interpolate them
  directly into shell commands.

## Reproducible builds

- Same commit, same inputs, same output: lockfiles committed, frozen installs, pinned tools.
- Avoid network fetches of unpinned resources during build (`curl | sh`, `latest` downloads).
- Record build provenance: commit SHA, pipeline run ID, tool versions, in artifact metadata.
- Build once, promote the same artifact through environments; do not rebuild per environment.
- Configuration that differs per environment is injected at deploy time, not baked into the build.

## Flaky jobs

- Do not add blanket retries to hide failures. Quarantine a known flaky test with an owner and
  issue reference, following the project's convention.
- Record runner, timing and seed for intermittent failures; use bug-loop to diagnose.

## Changing a pipeline safely

- Validate syntax with the platform's linter or schema if available locally.
- Exercise the change on a branch or a manually triggered run when authorized; pushing to trigger
  CI needs the assignment's permission.
- Keep the diff small; separate refactors of the pipeline from behavior changes.
- Check both success and failure paths (a failing test must fail the job).
- Note any change to required checks or branch protection; those settings are owner decisions.

## Review checklist

- Versions pinned; default permissions read-only; secrets scoped and not exposed to forks.
- Cache keys include the lockfile; pipeline passes cold.
- Artifacts tagged immutably and promoted, not rebuilt.
- Production deploy gated by approval or protected environment.
