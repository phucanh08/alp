---
name: security-review
description: "Review a change or component for security flaws: auth, permission boundaries, secrets exposure, injection, supply chain, unsafe filesystem use, remote execution, and sensitive logging, reporting rated findings with evidence. Use when a diff, PR, or component needs a security pass. Not for fixing a reported bug (bug-loop) or judging a whole release (release-readiness)."
---

# Security Review

## When to use

- A change touches authentication, authorization, input handling, secrets, files,
  processes, network calls, dependencies, or logging.
- A component or integration needs a focused security pass before merge or release.
- A reviewer or read-only agent is asked for security findings.

## Not for

- Fixing a confirmed vulnerability end to end: report it, then use bug-loop.
- Deciding whether a version ships: use release-readiness (it consumes these findings).
- Penetration testing or scanning live systems.

## Prerequisites

- A defined target: a diff, commit range, PR, or named component, plus the
  assigning agent's scope.
- Read ALP.md and project instructions for allowed commands and existing security tools.

## Workflow

1. Identify the target and its trust boundaries: who calls it, with what privilege,
   and which inputs come from untrusted sources (users, network, files, env, other
   services).
2. Map data flow from each untrusted input to sensitive sinks: queries, shell,
   filesystem, eval or deserialization, outbound requests, logs, responses.
3. Walk the checklist categories that apply to the target: authentication,
   authorization and permission boundaries, secrets exposure, input validation and
   injection, dependency and supply-chain risk, unsafe filesystem operations,
   remote execution boundaries, logging of sensitive data.
4. For each suspected issue, find the evidence: file:line of source, sink, and any
   missing or bypassable control. Trace far enough to confirm reachability.
5. Run existing project security tools (for example `npm audit`, a configured
   linter or secret scanner) only if they are already present and the session's
   mode allows running them. Record the command and result.
6. Rate each finding with the severity rubric and separate confirmed from suspected.
7. Write the report: findings with severity, evidence, exploit scenario, fix
   suggestion; then checked-and-clean areas; then what was not reviewed.

## Constraints

- This skill grants no extra permission. Review within the assigned scope and mode.
- Never run exploits or attack traffic against real systems, shared environments,
  or third-party services. Demonstrate reachability by reading code or by a local
  test in scratch space only when writing is authorized.
- Never read, print, or copy real secrets. Note their presence by path (and line)
  only, for example "credential-like value in config/prod.env:3".
- Never install scanners or new dependencies without explicit approval routed
  through the assigning agent.
- Read-only agents report findings; they do not patch code.
- Do not inflate severity to force action or deflate it to avoid friction; apply
  the rubric as written.

## Verification

- Every finding has severity, file:line evidence, exploit scenario, and fix.
- Confirmed findings show a traced path from input to sink; anything else is
  labeled suspected with the missing link stated.
- Tool runs list the exact command and outcome, or "not run" with the reason.
- Hand off the report to the assigning agent (peer -> lead -> main).

## Failure handling

- Cannot trace reachability: report as suspected with what would confirm it.
- Needed context is outside scope (another service, infra config): list it under
  "not reviewed" and name who can check.
- Live secret found: report path and line only, recommend rotation, and flag it to
  the assigning agent immediately as critical or high.
- Tool unavailable or not permitted: say so; do not substitute an unapproved install.

## References

- [references/checklist.md](references/checklist.md) — read when walking the review categories (step 3).
- [references/severity.md](references/severity.md) — read when rating findings and writing the report (steps 6-7).
