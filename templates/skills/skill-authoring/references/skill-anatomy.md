# Skill anatomy

Read when writing a skill's frontmatter, ordering its body, or laying out its files.

## Layout
```
<name>/
  SKILL.md              required; Level 1
  references/<topic>.md optional; Level 2, read when a step links it
  scripts/<tool>.mjs    optional; Level 3, run on demand only
  assets/<file>         optional; Level 3, templates or fixtures copied by a step
```
Library skills live in the user's library `skills/<name>/`; project skills in
`.alp/skills/<name>/`, which replaces the library skill of the same name in that project.

## Frontmatter
```
---
name: release-notes
description: "Draft release notes from merged changes ... Use when ... Not for ..."
---
```
- `name`: lowercase `a-z`, `0-9` and single hyphens; no leading, trailing or double
  hyphen; at most 64 characters; equal to the directory name.
- `description`: one line, at most 1024 characters by the format; the ALP index shows
  the first 400, and `alp_skill` accepts at most 300. No line breaks, no angle brackets.
- Optional keys allowed by the format: `license`, `compatibility` (environment needs,
  for example "Node 20+, git"), `metadata` (a map of string keys to string values, such
  as version or author), `allowed-tools` (advisory list; it grants nothing in ALP).
  Shipped ALP templates use only `name` and `description`; add optional keys only when
  a consumer reads them.

## Body sections
| Section | Holds |
|---|---|
| `# Title` | Imperative name of the job |
| When to use | Concrete situations, mirroring the description triggers |
| Not for | Neighbouring jobs and the skill that owns each |
| Prerequisites | What must be read or known before step 1 |
| Workflow | Numbered steps, each with an observable output |
| Constraints | Limits the agent must not cross |
| Verification | Checks that prove the result, not the effort |
| Failure handling | What to do when a step cannot complete |
| References | One line per file: link, then "read when ..." |

## Writing rules
- Imperative, specific, testable: "Run the project's test command", not "ensure quality".
- One idea per bullet; numbers only where order matters.
- State defaults and thresholds once; references extend, never repeat, the body.
- Prefer the project's own tools and conventions; never invent commands.
- Keep SKILL.md and each reference within about 110 lines; split by decision, not size.

## Scripts
- Node `.mjs`, run as `node scripts/<tool>.mjs <args>`; standard library first.
- Never install packages. If an optional dependency is absent, print
  "missing dependency: <name>; install it or skip step N" and exit with code 2.
- Deterministic output, no network unless the step says so, no writes outside the
  path given as an argument.
- Ship a test or a documented sample invocation with expected output.

## Versioning
- A user-edited library skill is the user's: propose a new version with `alp_skill`
  and `replace: true`; never edit the file in place.
- Record behavioural changes in the proposal summary, not in the body.
- Compatibility breaks (renamed sections a hook or role depends on, removed
  references) are new versions the user must approve.
