# Trigger design

Read when drafting a description, choosing non-triggers, or fixing a skill that fires on the wrong tasks.

## Shape
`<WHAT it does, verb first>. Use when <concrete triggers>. Not for <neighbours> (use <skill>).`
- WHAT: the output or change produced, in words a task request would use.
- WHEN: situations and nouns that appear in real requests: "failing test", "new
  endpoint", "ADR", "release branch".
- NOT FOR: the two or three closest neighbours, each pointing to its owner.
- Front-load distinctive words; the index may cut text after 400 characters.

## Choosing triggers
- Collect real phrasings from past tasks, lessons and handoffs before writing.
- Prefer task nouns and outcomes over method names the requester would not say.
- One skill, one job. If the WHEN list needs "or" across unrelated jobs, split it.

## Non-triggers
- Name every installed skill whose job is adjacent; agents compare descriptions.
- State the boundary as a decision rule: "a failure already exists" goes to bug-loop;
  "designing tests for new behaviour" stays here.
- Do not list unrelated jobs; noise weakens the boundary.

## Ambiguous overlaps
| Overlap | Resolve by |
|---|---|
| Two skills both plausible | Add the deciding condition to both descriptions |
| One task needs both in sequence | Say "then use X" in the body step, not the description |
| Project skill shadows library skill | Same name replaces it; a new name must state its narrower scope |

## Examples
Bad: `"Helps with documentation."` No WHAT, no WHEN, matches everything.

Bad: `"Use when needed for architecture, testing, docs, reviews or planning."` Five jobs,
no boundary, no output.

Good: `"Write and update architecture docs and ADRs from repository evidence. Use when a
boundary, contract or module structure changes or docs are missing. Not for
feature-level design (use feature-architecture)."`

Good: `"Draft release notes from merged changes since the last tag. Use when preparing a
release or changelog entry. Not for deciding if a release is ready (use
release-readiness)."`

## Repair checklist
- Fires too often: add a "Not for" with the stealing neighbour; narrow nouns.
- Never fires: add the words real requests use; move them to the front.
- Fires for the right reason but the body is ignored: the description promises
  something the body does not deliver; align them.
