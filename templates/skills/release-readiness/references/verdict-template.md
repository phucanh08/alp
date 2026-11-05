# Verdict Template

Read when deciding the verdict and writing the release readiness report.

## Decision rules

- NO-GO: any blocking criterion is FAIL, or a blocking criterion is NOT VERIFIED
  and cannot be verified before the planned release.
- CONDITIONAL: no blocking FAIL, and every remaining NOT VERIFIED or FAIL item has
  a named owner, a concrete closing action, and a "must close before" point
  (before tag, before publish, within N days after release for non-blocking).
- GO: every blocking criterion is PASS with evidence; non-blocking gaps are listed.

A CONDITIONAL verdict is not permission to release; the conditions marked "before
tag" or "before publish" must be closed and re-verified first.

## Report

```text
Release readiness: <project> <version>
Candidate: <SHA> (<branch/tag>), tree clean: <yes/no>
Assessed by: <agent/role>   Date: <YYYY-MM-DD>

Verdict: GO | CONDITIONAL | NO-GO
Reason: <one or two sentences naming the deciding criteria>

Criteria
| # | Criterion | Status | Evidence |
| 1 | Candidate pinned | PASS | git rev-parse HEAD -> <sha> |
| 2 | CI on exact SHA | NOT VERIFIED | CI not reachable from session; owner: <name> |
| ... |

Conditions (CONDITIONAL only)
- <action> | owner: <name> | must close before: <tag/publish/date> | verify by: <check>

Blocking failures (NO-GO only)
- <criterion>: <evidence> | suggested follow-up: <bug-loop/security-review task>

Accepted risks
- <risk> | accepted by: <user or named owner> | recorded in: <ADR/task note>

Not verified
- <criterion>: <why> | who can verify: <name/role>

Release actions pending user authorization
- <tag/publish/push/deploy steps>; none performed by this assessment.
```

## Writing tips

- Put the verdict and reason first; reviewers read top-down.
- Quote evidence briefly: the command and the decisive output line.
- Do not soften NO-GO into CONDITIONAL without owners and closing actions.
