# Release Readiness Criteria

Read when assessing each release criterion and deciding which are blocking.

Defaults below; the project's own release checklist or ALP.md overrides blocking
status. Status values: PASS, FAIL, NOT VERIFIED, N/A (with reason).

| # | Criterion | Blocking | Evidence that counts | Common traps |
| --- | --- | --- | --- | --- |
| 1 | Candidate pinned | yes | SHA, version string, clean tree (`git status`, `git rev-parse HEAD`) | Assessing a branch name instead of a SHA |
| 2 | CI green on exact SHA | yes | Required check names with status for that SHA | Green on PR head, not on merge commit; required check skipped |
| 3 | Release test suite | yes | Command, pass/fail/skip counts, run against the SHA | Skipped tests hidden in totals; flake retried until green without note |
| 4 | Artifacts from SHA | yes | Build log or provenance naming the SHA; version stamp in artifact; checksum match | Artifact rebuilt locally from a dirty tree; stale cached artifact |
| 5 | Security findings | yes for critical/high | List of open findings with severity and status | Findings tracked elsewhere not checked; audit not run and called clean |
| 6 | Protocol/API compatibility | yes if breaking and unannounced | Diff of public surface since last release; changelog entry | Config or CLI flag changes overlooked |
| 7 | Migrations tested | yes if present | Migration run on representative data; result | Tested only on empty data |
| 8 | Migration reversibility | yes if irreversible without backup | Down-migration test, or backup and forward-fix plan | Assuming reversibility without running it |
| 9 | Rollback plan | yes | Written steps, who runs them, rehearsal result if any | Rollback blocked by an irreversible migration |
| 10 | Release notes | no | Path or link; covers breaking changes and migrations | Notes generated from commits, missing user impact |
| 11 | Docs updated | no | Changed doc paths | Docs describe unreleased behavior |
| 12 | Monitoring and alerts | no, yes for risky changes | Dashboard or alert names covering new behavior | New failure mode with no signal |
| 13 | On-call / owner aware | no | Named owner and acknowledgement | Release window outside owner availability |

## Gathering evidence

- Prefer commands whose output is reproducible: record the command line and the
  relevant lines of output, not a paraphrase.
- When CI or artifact storage is not reachable from the session, ask the assigning
  agent for a link or export; until then the criterion is NOT VERIFIED.
- Re-use security-review output for criterion 5 if it covered the candidate SHA;
  otherwise state its coverage gap.
- N/A needs a reason ("no migrations: no schema or config format changes since
  v1.4.0, checked by diff of migrations/ and config schema").

## Blocking overrides

- A project rule may make a non-blocking item blocking (for example, release notes
  required by policy). Cite the rule.
- Downgrading a blocking item to non-blocking requires an explicit decision by the
  user or an owner the user named; record who decided.
