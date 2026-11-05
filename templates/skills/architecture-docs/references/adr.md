# Architecture decision records

Read when judging whether a change warrants an ADR, writing one, or changing an ADR's status.

## When an ADR is warranted
Write one when at least one holds:
- The choice is costly to reverse: data store, protocol, public API style, runtime,
  framework, deployment model.
- It changes a module boundary or the allowed dependency direction.
- It affects compatibility for consumers, stored data or supported platforms.
- Reasonable alternatives were seriously considered and rejected.
- The team will otherwise relitigate it.

Skip an ADR for: refactors inside one module, dependency patch updates, naming, local
helpers, bug fixes that restore the documented contract, and choices fully dictated by
an existing ADR. A sentence in the relevant doc is enough.

## File and numbering
- Follow the project's existing ADR location and numbering. Default:
  `docs/architecture/decisions/NNNN-short-title.md`, four digits, next free number.
- Never renumber or delete an ADR; supersede it.

## Template
```markdown
# NNNN. Short decision title

- Status: Proposed | Accepted | Superseded by NNNN | Deprecated
- Date: YYYY-MM-DD
- Deciders: who confirmed it (role or name as the project records it)

## Context
The forces and constraints, with evidence paths. What problem forces a choice now.

## Decision
The choice, stated as one or two sentences in active voice.

## Alternatives
- Option: why it was not chosen.

## Consequences
What gets easier, what gets harder, follow-up work, and what to watch.

## Evidence
Files, tests, benchmarks or discussions that support the context and decision.
```

## Status lifecycle
| Status | Meaning | Who moves it |
|---|---|---|
| Proposed | Drafted, not yet confirmed | Any writer; route to main for a decision |
| Accepted | Confirmed by whoever owns the decision | Main, after the user or authorised owner confirms |
| Superseded by NNNN | Replaced; keep text, link the new ADR | The writer of the new ADR |
| Deprecated | No longer applies, nothing replaces it | Main, with the reason in a dated note |

- An agent never marks its own proposal Accepted without that confirmation.
- Editing an Accepted ADR is limited to typos and links; a changed decision is a new ADR.
