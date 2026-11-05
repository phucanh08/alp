---
name: feature-architecture
description: "Implement a new feature so it fits the project's existing architecture rules, boilerplate, and dependency direction, with a short design first and boundary checks after. Use when adding a feature to a codebase with architecture docs, ADRs, templates, or a boundary contract. Not for behavior-preserving restructuring (safe-refactor) or fixing a regression (bug-loop)."
---

# Feature Architecture

## When to use

- A new feature, endpoint, module, or command must land in a project that has
  architecture docs, ADRs, layer or package rules, or feature boilerplate.
- A read-only architect or reviewer is asked whether a planned feature fits the
  project's architecture (advice only).

## Not for

- Restructuring existing code without behavior change: use safe-refactor.
- Reproducing and fixing a bug or regression: use bug-loop.
- Writing or reorganizing architecture documentation itself: use architecture-docs.
- Choosing a new architecture style for the project: that is a user decision.

## Prerequisites

- An assigned scope (paths or modules) and acceptance criteria from the brief.
- Read access to ALP.md, project instructions, and architecture docs if present.

## Workflow

1. Read ALP.md and the project's own instructions; note commands for build, test,
   lint, and boundary checks.
2. Read the relevant architecture docs (for example `docs/architecture/`, ADRs,
   package READMEs). Read only what bears on the modules this feature touches.
3. List the rules in two groups. Hard constraints: dependency rules, file placement,
   public API compatibility, required interfaces or registration points. Soft
   conventions: naming, folder shape, test style. Cite the source of each rule.
4. Find the boilerplate or template (for example `templates/features/`) and the
   most similar existing feature. Mirror its structure, wiring, and tests.
5. Map the modules touched and the direction of every new dependency. A new edge
   must point the way existing edges of that kind already point.
6. Write a short feature design: files to add or change, owning module, public
   surface, tests. Put it in the lead/peer brief or the task notes.
7. Implement following existing conventions. Stay inside owned paths.
8. Run architecture checks. Use the project's own lint and boundary tools first. If
   the project adopted ALP's contract file, also run
   `node <this skill dir>/scripts/check-boundaries.mjs --root <repo>`; it reads
   `docs/architecture/contract.json` by default and exits 1 on violations. See
   [scripts/check-boundaries.mjs](scripts/check-boundaries.mjs).
9. Review the diff against the design. Update architecture docs or the contract
   only if a boundary or contract actually changed.

A read-only architect or reviewer runs steps 1-6 and 8 against the proposal or
current tree, then reports findings and a recommended design instead of editing.

## Constraints

- Never impose Clean Architecture, DDD, Hexagonal, or any framework or pattern the
  project does not already use.
- Do not add an abstraction, layer, or interface only to satisfy a generic pattern.
- If the architecture cannot satisfy the requirement, stop. State the conflict,
  the trade-off, and the options, and route the decision upward
  (peer -> lead -> main -> user).
- An exception to a hard rule needs an explicit recorded decision (an ADR or a
  task note naming who approved it). Never bypass a rule silently, and never
  edit the contract or a lint config to make a violation pass.
- Read-only agents (architect, reviewer) report findings; they do not edit.
- The skill grants no authority to install tools, widen scope, or write outside
  owned paths.

## Verification

- Project lint, type check, tests, and boundary tools pass on the final tree.
- `check-boundaries.mjs` exits 0 when the project uses the contract file.
- Every new dependency edge matches the mapped direction from step 5.
- Hand off: checker commands with output, files changed grouped by module, and
  any approved exception with its record location and approver.

## Failure handling

- Boundary violation: move the code or invert the dependency the way the analogous
  feature does; re-run the checker. Do not weaken the rule.
- No analogous feature or template: say so, propose the closest fit, and ask the
  assigning agent before inventing a new structure.
- Conflicting docs and code: follow the code that the checks enforce, record the
  discrepancy, and report it upward.
- Checker missing or failing to run: report the exact command and error; do not
  claim the boundaries were verified.

## References

- [references/feature-design.md](references/feature-design.md) — read when writing the feature design (step 6), choosing the analogous feature (step 4), or checking dependency direction (step 5).
- [references/architecture-contract.md](references/architecture-contract.md) — read when the project has or wants a machine-checkable architecture contract.
