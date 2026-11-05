# Skill evaluation

Read when building trigger scenarios for a skill and running its dry evaluation.

## Scenario table
Write 8-12 rows before claiming the skill works. Mix positive, negative and ambiguous.

| # | Task (as a requester would phrase it) | Role | Expected skill(s) | Must not select | Kind |
|---|---|---|---|---|---|
| 1 | "Add tests for the new refund endpoint" | lead | test-strategy | bug-loop | positive |
| 2 | "Refund test fails since yesterday" | peer | bug-loop | test-strategy | negative |
| 3 | "Add the refund endpoint and its tests" | lead | feature-architecture, then test-strategy | - | ambiguous |

- Use only skills actually assigned to the role in the row.
- Negative rows come from the nearest neighbours named in "Not for".
- Ambiguous rows must end with a resolution: a sequence, a deciding condition added to
  a description, or an accepted overlap stated in both skills.

## Trigger check
1. Give a fresh agent, or yourself without the body, only the index lines (name plus
   description) of the role's skills and the task text.
2. Record which skill it picks and the words that decided it.
3. A miss on a positive row or a hit on a must-not row is a description defect; edit
   and rerun the whole table, not just the failing row.

## Dry run
1. Pick a real, small task from the project or its history.
2. Follow the body literally, in order, reading references only when a step links them.
3. Note every place you had to guess, skip, or improvise: each is a missing or wrong
   instruction.
4. Note any step that produced no observable output: tighten or delete it.
5. If the skill has scripts, run them on real input and on a missing-dependency case.

## Evidence record
Keep with the proposal or handoff:
- the scenario table with actual picks and pass or fail per row;
- the dry-run task, the steps that needed changes, and what changed;
- `alp skill check <name> --strict` output;
- known gaps not yet evaluated.

## Do not claim
- Quality from a passing validator: it checks format, not usefulness.
- Coverage from scenarios you wrote but did not run.
- Improvement from a revision without rerunning the scenarios that motivated it.
