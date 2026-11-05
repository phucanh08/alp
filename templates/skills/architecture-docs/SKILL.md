---
name: architecture-docs
description: "Create and maintain architecture docs from repository evidence: overview, boundaries, module dependencies, data flow, API contracts, decisions, ADRs, Mermaid diagrams and conventions. Use when docs are missing, stale, or a change alters a boundary or contract. Not for designing a new feature (use feature-architecture) or researching reuse (use xia)."
---

# Document the architecture the code proves

## When to use
- A project has no architecture overview, or the existing one contradicts the code.
- A change adds, removes or moves a module boundary, public API, schema or data flow.
- A technology or structural decision was confirmed and needs an ADR.
- A docs-maintainer or reviewer is asked to check architecture docs for drift.

## Not for
- Designing how a new feature should be built: use feature-architecture.
- Comparing libraries or finding reusable code: use xia.
- User guides, READMEs and changelogs unrelated to structure.
- Guessing intent for code nobody can explain: record an open question instead.

## Prerequisites
- Read ALP.md and any existing docs index, `docs/` tree or contributing guide.
- Know the owned paths: writers edit only assigned doc files; read-only roles report.
- Identify the change or question that triggered the work; scope docs to it.

## Workflow
1. **Find the layout.** Follow the project's existing docs layout. If none exists,
   propose `docs/architecture/overview.md`, `boundaries.md`, `conventions.md` and
   `decisions/NNNN-title.md`, and confirm before creating new top-level structure.
2. **Collect evidence.** Read manifests, entry points, build and deploy config, route
   files, schemas, the import graph and tests for the area in scope. Record each fact
   with the file path that proves it.
3. **Overview.** Purpose, runtime units (processes, packages, services), how they start
   and talk, and external systems. One short page.
4. **Boundaries and dependencies.** Each module's responsibility, what it may import,
   what imports it, and the public surface others rely on. Note cycles and leaks found.
5. **Data flow and contracts.** Trace the main request or job path end to end. For each
   API, event or schema, cite its definition file and versioning rule.
6. **Decisions.** Record confirmed technology and structural choices with the evidence
   or the person who confirmed them. Write an ADR only when the criteria in the ADR
   reference are met; otherwise one line in the overview is enough.
7. **Diagrams.** Add a Mermaid diagram only where text is harder to follow. Keep it
   small and derived from code: every node maps to a real path.
8. **Conventions.** Document naming, layering, error handling, logging and testing
   patterns that the code already follows consistently, with an example path each.
9. **Unknowns.** Mark anything not proven as "Unverified" and list open questions with
   who can answer them. Route decisions upward; do not invent them.
10. **Check.** Verify links, paths and examples (see Verification), then hand off with
    the evidence list.

## Constraints
- Describe only what code, config, tests or confirmed decisions prove. No aspirational
  architecture presented as current.
- Cite evidence as relative file paths, with a symbol or line range when helpful.
- Keep docs in sync: a change that alters a boundary or contract updates its doc in the
  same change. Small internal changes need no ADR and often no doc edit.
- Do not refactor code to match the docs; report the mismatch instead.
- Read-only roles (architect, reviewer) return findings and proposed text, not edits.

## Verification
- Every relative link and cited path resolves; run the project's link checker if it
  has one, otherwise check each path exists.
- Code examples and commands in the docs run or compile against the current tree, or
  are marked illustrative.
- Each diagram node and arrow matches an import, call, route or config entry.
- No statement lacks evidence or an "Unverified" mark.

## Failure handling
- Evidence conflicts (code says one thing, config or docs another): document what runs,
  flag the conflict as an open question, and report it.
- Area too large for the assignment: document the boundary and entry points, list
  uncovered modules, and return; do not expand scope.
- Decision needed but unconfirmed: draft the ADR as `Proposed` and route it to main.
- Existing docs layout is unclear or contested: ask before restructuring.

## References
- [references/evidence-rules.md](references/evidence-rules.md) — read when collecting facts and citing them (steps 2-5, 9).
- [references/adr.md](references/adr.md) — read when deciding whether a change needs an ADR or writing one (step 6).
- [references/diagrams.md](references/diagrams.md) — read when adding or updating a Mermaid diagram (step 7).
