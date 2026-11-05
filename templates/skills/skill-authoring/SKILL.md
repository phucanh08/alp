---
name: skill-authoring
description: "Design, write, validate and improve one agent skill: requirements, trigger description, progressive disclosure, references, optional scripts and trigger evaluation. Use when creating a new skill or revising one skill's scope, description or structure. Not for reviewing or retiring the whole lesson and skill catalog; use curate instead."
---

# Author one skill

## When to use
- A repeated workflow, three or more related lessons, or a user request calls for a new skill.
- One existing skill triggers wrongly, misses its tasks, or has grown too long to follow.
- A skill needs references, a deterministic script, or a project-specific override.

## Not for
- Merging, pruning or retiring lessons and skills across the catalog: use curate.
- One-off instructions for a single task: put them in the brief or ALP.md instead.
- Changing role authority: a skill grants no permissions and cannot widen scope.

## Prerequisites
- Read ALP.md and the skills already assigned to the target roles; avoid duplicates.
- Know where it will live: user library (proposed by main via `alp_skill`) or project
  (`.alp/skills/<name>/` in the repository, a normal reviewed change).
- Have at least one real task the skill should have helped with.

## Workflow
1. **Requirements.** Write the job in one sentence, the roles that use it, the inputs it
   assumes, and the observable result it must return. Drop anything a capable agent
   already does without instructions.
2. **Trigger spec.** List 3-5 positive tasks that must select it and 3-5 neighbouring
   tasks that must not, each naming the skill that owns it instead.
3. **Description.** It is the only text an agent sees at session start. State WHAT, then
   "Use when ...", then "Not for ... (use X)". Keep the key words in the first 400
   characters shown by the ALP index; `alp_skill` accepts at most 300.
4. **Disclosure levels.** Level 0: name and description (always loaded). Level 1:
   SKILL.md body, read when the description matches. Level 2: references, read only at
   the step that links them. Level 3: scripts and assets, run on demand and never at
   discovery. Put each fact at the lowest level that still reaches the step needing it.
5. **Body.** Sections in order: When to use, Not for, Prerequisites, Workflow (numbered),
   Constraints, Verification, Failure handling, References. Terse imperatives, no
   history, no restated role rules, at most about 110 lines.
6. **References.** One topic per file, kebab-case, one level deep, each linked from the
   step that needs it with "read when ...". Split a reference when it covers two
   decisions; delete one that no step links.
7. **Scripts (optional).** Add one only when the same deterministic transformation or
   check is repeated and error-prone in prose. Use Node `.mjs` run with `node`; no
   auto-installed dependencies; print a clear message naming any missing dependency
   and exit non-zero; include a test or a sample run with expected output.
8. **Validate.** Run `alp skill check <name|dir>`, then `--strict` before proposing.
   Fix every error and warning; valid frontmatter alone proves nothing about quality.
9. **Evaluate.** Run the trigger scenarios against the description and do one dry run
   on a real task by following the body literally; record gaps and fix them.
10. **Deliver.** Library skill: main proposes it with `alp_skill` (name, description,
    body, roles) and the user approves. `alp_skill` writes only SKILL.md, so references
    and scripts are added by the user or via `alp skill new` / `alp skill edit`.
    Project skill: write `.alp/skills/<name>/` within owned paths and hand off.

## Constraints
- Never overwrite a user-edited library skill. Read it, then propose a new version with
  `alp_skill` and `replace: true`; the user approves or rejects it.
- To change behaviour for one project only, add an override in `.alp/skills/<name>/`
  instead of editing the library copy.
- No tool names specific to one runtime, no secrets, no instructions to push, release,
  install dependencies or write outside owned paths.
- Keep names stable once roles reference them; renaming is a retire plus a new skill.

## Verification
- `alp skill check <name> --strict` passes with no warnings.
- Every positive scenario selects the skill; every negative one selects the named
  alternative or none; ambiguous cases are resolved in the description.
- The dry run reached the stated result without improvising missing steps.
- Every reference and script is linked from a step and exists.

## Failure handling
- Validator errors: fix the file and rerun; do not edit the validator or skip `--strict`.
- Overlap with an existing skill: narrow one description, or propose merging via curate.
- User rejects the proposal: revise from the feedback and propose again; do not write
  the library file directly.
- No real task to dry-run on: deliver as a draft and state that evaluation is pending.

## References
- [references/skill-anatomy.md](references/skill-anatomy.md) — read when writing frontmatter, choosing sections or laying out files (steps 3-7).
- [references/trigger-design.md](references/trigger-design.md) — read when drafting or repairing the description and non-triggers (steps 2-3).
- [references/evaluation.md](references/evaluation.md) — read when building the scenario table and running the dry evaluation (step 9).
