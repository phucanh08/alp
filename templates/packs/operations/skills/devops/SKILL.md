---
name: devops
description: "Plan and change containers, CI/CD pipelines, deployment and rollback strategy, infrastructure-as-code and observability with reviewable, reversible steps. Use when editing Dockerfiles, pipeline configs, IaC, deploy scripts, alerts or dashboards. Not for application feature code, release go/no-go (release-readiness) or secret audits (security-review)."
---

# Containers, pipelines, deployment and observability

## When to use

- Writing or changing a Dockerfile, compose file or container build.
- Adding or fixing a CI/CD pipeline stage, cache, matrix or release job.
- Planning a deployment strategy, database migration ordering or rollback.
- Changing infrastructure-as-code (Terraform, Pulumi, CloudFormation, Helm, Kubernetes manifests, and similar).
- Adding logs, metrics, traces, SLOs, alerts or dashboards.

## Not for

- Deciding whether a release may ship: release-readiness.
- Auditing code or config for vulnerabilities and leaked secrets: security-review.
- Diagnosing a failing test or regression in application code: bug-loop.
- Application features that only happen to run in a container.

## Prerequisites

- Read ALP.md, existing pipeline configs, Dockerfiles, IaC and deploy docs. Establish the actual
  platform, tools and versions from files, not assumptions.
- Know which environments exist (local, CI, staging, production), who owns them, and what the
  assignment authorizes. Authorization to edit a file is not authorization to apply it.

## Workflow

1. Inventory: current build, pipeline, deploy path and monitoring for the affected service.
   Record what was searched and found.
2. State the change and its blast radius: which environments, services and users it can affect,
   and how it is undone.
3. Make the smallest change in the existing tool and layout. Reuse existing stages, base images,
   modules and naming.
4. Verify locally or in a non-production context: build the image, lint and validate the pipeline
   or IaC, run the plan or dry-run command the tool provides, and run the project's tests.
5. For deploy-affecting changes, write the rollout and rollback steps, including migration order
   and how success is measured.
6. Add or update observability so the change can be seen working or failing.
7. Hand off: files changed, validation commands and output, plan or diff output, rollout and
   rollback notes, and every action that still needs an authorized human to run.

## Constraints

- Follow the project's existing stack, platforms and conventions first.
- Do not add dependencies, services, cloud resources, paid features or new providers without the
  owner's decision. No auto-install of tools or plugins.
- Never deploy, apply infrastructure changes, run migrations against shared databases, rotate keys,
  change DNS or touch production systems or credentials without explicit authorization for that
  specific action. Plans, dry runs and local builds are the default.
- Never put secrets in images, pipeline files, IaC, logs or committed env files. Reference the
  platform's secret store or environment variables; do not read or print existing secret values.
- Do not push, tag or trigger release pipelines unless the assignment explicitly says so.
- Pin versions (base images, actions, tools, providers) rather than floating tags.
- Read-only agents review and propose; they do not edit or run mutating commands.

## Verification

- Image builds locally; runs as non-root; healthcheck passes; no secrets in layers or build args.
- Pipeline config validates with the platform's linter or a dry run where available; changed jobs
  were exercised or the reason they could not be is stated.
- IaC plan or diff output is attached and contains only the intended changes.
- Rollback steps exist for every deploy-affecting change and were rehearsed or marked unrehearsed.
- New alerts have a threshold, an owner, and a runbook link or next step.

## Failure handling

- Validation tool unavailable locally: state it, provide the exact command for an authorized
  person, and do not claim the change works.
- Plan shows unexpected changes (drift, replacements, deletions): stop, report the diff, and
  route upward before any apply.
- Pipeline fails only in CI: compare runner image, tool versions, cache and environment variables
  with local; reproduce in a matching container when possible.
- Missing access or credentials: report what is needed and for which environment; never work
  around it with personal tokens or broadened permissions.

## References

- [references/containers.md](references/containers.md) — read when writing or reviewing a Dockerfile or container build.
- [references/ci-cd.md](references/ci-cd.md) — read when changing pipeline stages, caching, versions or tokens.
- [references/deployment-and-rollback.md](references/deployment-and-rollback.md) — read when planning a rollout, migration or rollback in step 5.
- [references/observability.md](references/observability.md) — read when adding logs, metrics, traces, SLOs or alerts in step 6.
