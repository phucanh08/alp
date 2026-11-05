---
name: release-readiness
description: "Assess whether a specific build or version is ready to release and return a GO, CONDITIONAL, or NO-GO verdict with evidence for every criterion: CI, tests, artifacts, security, compatibility, migrations, rollback, operations. Use when asked if a version can ship. Not for tagging or publishing, reviewing a single change (security-review), or fixing failures (bug-loop)."
---

# Release Readiness

## When to use

- Someone asks whether a commit, build, or version can be released.
- A release candidate needs a documented go/no-go before the user authorizes shipping.
- A reviewer is asked to audit an existing release checklist or claim.

## Not for

- Tagging, publishing, pushing, or deploying: those need the user's explicit
  authorization and are outside this skill.
- A security pass on one change: use security-review, then feed its findings here.
- Fixing a failing test or build: use bug-loop.

## Prerequisites

- The exact candidate: commit SHA (and tag or version string if already chosen).
- Read ALP.md and project instructions for the project's release process, CI,
  build, and test commands, and any existing release checklist.

## Workflow

1. Pin the candidate: record the commit SHA, branch, version string, and whether
   the working tree is clean. Every later check refers to this SHA.
2. CI status: confirm the required checks passed on that exact commit, not a
   neighbor or a branch head that moved. Record check names and links or output.
3. Tests: run or locate the results of the project's release test suite on the
   SHA. Record command, pass/fail counts, skipped tests, and known flakes.
4. Build artifacts: confirm they were built from the SHA, carry the right version
   stamp, and match recorded checksums. Note any artifact not inspected.
5. Security: list open findings that affect the candidate (from security-review,
   audit tools allowed by the session, issue tracker) with severity and status.
6. Compatibility: protocol, public API, CLI, config, and data format changes since
   the last release, with consumers' required actions.
7. Migrations: data or config migrations, whether each was tested, and whether it
   is reversible; if not reversible, what backup or forward-fix covers it.
8. Rollback plan: the concrete steps and who can execute them; whether rollback
   was rehearsed.
9. Operational readiness: release notes, docs, monitoring and alerts for new
   behavior, on-call or owner awareness.
10. Decide the verdict and write it with the verdict template.

## Constraints

- Every criterion has evidence (command and result, link, or file path) or is
  marked "not verified" with the reason. Never mark PASS for something not run
  or not inspected.
- Evidence must be for the pinned SHA. Results from another commit are "not
  verified".
- Do not tag, publish, push, deploy, or bump versions. Report the verdict; main
  obtains the user's authorization for any release action.
- Do not install tools or change CI config to make a check pass.
- Read-only agents assess and report only.

## Verification

- Verdict follows the rules: any failed blocking criterion is NO-GO; unverified
  or failed non-blocking items with owners and deadlines may be CONDITIONAL; GO
  only when every blocking criterion passed with evidence.
- Each CONDITIONAL condition names an owner and what closes it.
- Hand off the verdict report to the assigning agent (peer -> lead -> main).

## Failure handling

- CI or artifacts not reachable from this session: mark "not verified", name who
  can confirm, and do not issue GO.
- Candidate SHA changed mid-assessment: restart from step 1 for the new SHA.
- Blocking failure found: issue NO-GO with the evidence; suggest bug-loop or
  security-review follow-ups as separate tasks.
- Project has no rollback path: that is a blocking gap unless the user explicitly
  accepts the risk; record who accepted it.

## References

- [references/checklist.md](references/checklist.md) — read when assessing each criterion (steps 2-9).
- [references/verdict-template.md](references/verdict-template.md) — read when deciding and writing the verdict (step 10).
