# Skill system

How ALP gives agents skills, keeps their context small, checks skill files, and adds
specialist skills and agents only when you ask. For where skills live and who gets them,
see [role skills](role-skills.md); for agents, teams and hooks, the
[agent library](agent-library.md).

## Kinds of skills

| Kind | Where | Who gets it |
|---|---|---|
| Core | shipped in `templates/skills/`, seeded into `~/.alp/skills/` | the roles `role-skills.json` lists |
| Optional pack | shipped in `templates/packs/<pack>/`, **never seeded** | nobody until you install it and assign it |
| Project | `<project>/.alp/skills/<name>/` | replaces a library skill of the same name; custom agents name it in `agent.json` |

Core skills (15): goal-griller, xia, sequence-execution-plan, prompt-leverage, bug-loop,
smart-commits, compact, curate, and since skill system v2 skill-authoring,
architecture-docs, feature-architecture, test-strategy, safe-refactor, security-review and
release-readiness. The [role skills table](role-skills.md) shows who gets which.

## Progressive disclosure

An agent's context holds only what it needs to choose a skill. The rest stays in files.

| Level | What | When the agent has it |
|---|---|---|
| 0 | name, path and description of **its own** skills (description clipped to 400 characters) | from the session's start, in its instructions |
| 1 | `SKILL.md`: purpose, triggers, workflow, constraints, verification | when a task matches the description, the agent reads it |
| 2 | `references/*.md` | only the reference a step needs |
| 3 | `scripts/`, `assets/`, `templates/`, `data/` | a script runs only when the workflow calls for it and the session's permissions allow |

- ALP never injects bodies, references or scripts, and never runs a script at discovery.
  Skills of other roles are not listed.
- A skill never adds authority: the session's mode and permission profile decide what an
  agent may do, whatever a skill or its `allowed-tools` says.
- Each first read of a skill is logged (`✦ peer uses skill bug-loop`), and so is each
  first opening of one of its resources (`✦ peer opens bug-loop/references/test-proof.md`),
  so `alp log` shows what was loaded on demand.

How each runtime gets skills:

| Runtime | Level 0 | Opening a skill |
|---|---|---|
| Claude Code | instructions index, and the skills as native Claude Code skills `alp:<name>` (a per-session plugin links each skill directory) | Skill tool, or reading the file |
| Codex | instructions index | reading `SKILL.md` and its files |
| ACP agents (OpenCode, Gemini CLI, …) and Antigravity | the same index, sent with the first prompt | reading the files with the agent's own tools; no Skill tool is emulated |

Measured with `node scripts/skill-eval.mjs disclosure` (characters measured, tokens
estimated as characters / 4):

| Role | Skills before / after v2 | Index chars before / after | Bodies + resources not loaded, after |
|---|---|---|---|
| main | 8 / 15 | 2751 / 5873 | 109 KB |
| lead | 5 / 11 | 1847 / 4546 | 88 KB |
| peer | 3 / 6 | 1247 / 2589 | 51 KB |
| reviewer | 0 / 2 | 0 / 1264 | 19 KB |

Main's index grew by about 780 tokens (estimate); oracle and supervisor have none.

## Skill format

ALP follows the [Agent Skills format](https://agentskills.io/specification):

```text
skill-name/
  SKILL.md            frontmatter + instructions
  references/*.md     detail, read on demand
  scripts/            deterministic helpers (Node .mjs preferred: no install step)
  assets/             templates, data
```

```yaml
---
name: skill-name          # 1-64 lowercase letters, digits, single hyphens; equals the directory
description: "What it does. Use when <triggers>. Not for <non-triggers>."
---
```

Optional keys: `license`, `compatibility` (≤500 characters), `metadata` (text values),
`allowed-tools` (advisory only in ALP). The description is all an agent sees before
opening a skill: say what and when in under 400 characters.

### Validation

```sh
alp skill check                      # every skill of the project and the library (legacy mode)
alp skill check feature-architecture # the one that applies
alp skill check ./my-skill --strict  # a directory, strictly
alp doctor                           # reports library skills that do not meet the format
```

- **Strict** (shipped skills, packs, `alp_skill` proposals, `--strict`): format problems
  are errors.
- **Legacy** (default for existing skills): format problems are warnings with a hint, and
  the skill keeps loading. ALP never rewrites a skill to fit the format.
- Always errors: a symlink (or a link through one) leaving the skill directory, a broken
  symlink, an unreadable file. A plain path leaving the skill (`../other/SKILL.md`, an
  absolute path) is an error for new skills and a warning for existing ones, since it does
  not travel with the skill.
- Checked: SKILL.md exists, YAML frontmatter parses (the subset skills use), name rules and
  name = directory, description present, length and trigger wording, unknown or
  runtime-specific keys, every relative link and `references/` path resolves inside the
  skill, symlinks, bundled `node_modules`, shipped files are UTF-8 text, a `#!` script is
  executable.

`alp_skill` (main proposing a skill from lessons) refuses a draft whose frontmatter fails
strict validation or whose body links files the skill would not have.

### Packaging

- Bundles carry shipped templates as UTF-8 text, so shipped skills hold text files only
  (the validator enforces it). A shipped script starting with `#!` is made executable
  where ALP writes it.
- `alp skill cp` copies the whole skill directory (bytes and modes kept) and refuses a
  source that contains a symlink.
- Library and project skills are used in place: Claude's plugin links the directory, other
  runtimes read the files, so your bytes and permissions are what agents see.

## Writing a skill

Main has the **skill-authoring** skill; **curate** keeps the catalog lean. In short:

1. One responsibility per skill. Prefer a reference over a second skill.
2. Write the description first: what, "Use when …", "Not for … (use X)".
3. Keep SKILL.md short: When to use, Not for, Prerequisites, Workflow, Constraints,
   Verification, Failure handling, References (each with "read when …").
4. Add a script only for a repeated, deterministic step; no auto-installed dependencies,
   a clear message when one is missing, and a test.
5. `alp skill check <dir> --strict`, then try it on a real task and a task it must not
   trigger on (see Evaluation).

Library skills: `alp skill new <name> --file SKILL.md`, then add `references/` beside it.
Project skills: commit `.alp/skills/<name>/`.

## Optional packs

```sh
alp packs                             # what ships, and what you have installed
alp pack install backend              # copy into ~/.alp; assigns nothing
alp pack install backend --assign     # also give the pack's suggested skills to roles
alp pack install frontend --project   # into this project's .alp/
```

| Pack | Contents | Suggested roles |
|---|---|---|
| backend | backend-development, databases | lead, peer |
| frontend | frontend-development | lead, peer |
| quality | web-testing | lead, peer, reviewer |
| design | ui-design | lead, peer |
| integration | mcp-integration | lead, peer |
| operations | devops | lead, peer |
| architecture | agents architect and docs-maintainer, team blueprint | — |

- An entry that already exists (yours, or installed before) is kept, never overwritten;
  updates of ALP never touch installed pack skills.
- Nothing is installed besides files, and no dependency is fetched.
- `--assign` appends to `role-skills.json` in the library; in a project, name skills in a
  project agent (`alp agent edit lead --project --skills backend-development`).
- Pack skills mention skills of other packs by name only; installing one pack never
  needs another.

## Specialized agents

The **architecture** pack adds two custom agents, using the existing roles rather than new
built-in ones:

- **architect** — team role `advisor`, read-only: architecture fit, boilerplate
  compliance, dependency direction, ADR recommendations. It recommends; main (and the user)
  decide. Installing the pack adds `"architect": "read-only"` to `permissions.agents` in the
  same scope's settings when the agent has no entry; an existing entry is reported, never
  changed. Delegations to it are capped read-only even when the caller asks for writes.
- **docs-maintainer** — team role `peer`: architecture docs, API docs, migration guides,
  ADRs, links and examples, inside the paths its brief or task assigns.
- **blueprint** team — main accepts; lead runs execution with peer and docs-maintainer;
  architect advises; reviewer checks. Delegation: main → lead, architect, reviewer;
  lead → peer, docs-maintainer, architect, reviewer. Phở and Cafe are unchanged.

Planner, researcher, debugger, code-reviewer, fullstack-developer, git-manager and
project-manager agents are not added: main, lead, peer, oracle and reviewer with the core
skills cover them.

## Architecture compliance

For projects with architecture docs or boilerplate:

1. Write the docs from evidence (architecture-docs): `docs/architecture/overview.md`,
   `boundaries.md`, `conventions.md`, `decisions/` — or the project's own layout.
2. Agents follow them with **feature-architecture**: read ALP.md and the docs, separate
   hard rules from conventions, mirror the boilerplate and the closest feature, check
   dependency direction, run the checks, update docs only when a boundary changed.
3. Make the rules checkable. Use the project's own tool when it has one (ESLint boundaries,
   dependency-cruiser, Nx, import-linter, ArchUnit). For JavaScript/TypeScript without one,
   the skill ships `scripts/check-boundaries.mjs`, which reads
   `docs/architecture/contract.json` (modules, allowed dependencies, denied packages,
   exceptions with reason and approver); its format is in the skill's
   `references/architecture-contract.md`. Copy it into the repository for CI.
4. Gate on it with a blocking hook that the agents doing the work name:

```sh
alp hook add architecture --project --event handoff --command "node tools/check-boundaries.mjs" --blocking
alp agent edit peer --project --hooks architecture
```

A violation refuses the handoff with `file:line  from -> to: rule` as the reason. An
exception is a recorded decision in the contract (`reason`, `approvedBy`), never a silent
edit. `test/fixtures/architecture-app` and `test/integration/architecture-contract.test.js`
show a valid feature passing and a deliberate violation caught, both by the checker and as
a refused peer handoff (`test/integration/hooks.test.js`).

## Evaluation

```sh
node scripts/skill-eval.mjs disclosure          # Level 0 size per role, bodies never injected
node scripts/skill-eval.mjs triggers            # scenarios agree with the role mapping
node scripts/skill-eval.mjs triggers --live     # ask a model (Claude API; costs money)
```

`test/evals/skills/triggers.json` holds positive, negative, ambiguous, role-specific and
multi-skill scenarios. The static checks run in the test suite; the model-graded run needs
credentials and is never run by default. Valid frontmatter is not evidence that a skill
works: judge a skill by scenario results and real tasks.

## Upgrading

- **Unedited `role-skills.json`:** replaced with the v2 mapping on the next session or
  `alp upgrade`.
- **Edited `role-skills.json`:** `alp upgrade` / `alp update-template` offers the new core
  skills once to the roles your file lists, at the end of their lists; a skill you then
  remove stays removed. Custom roles are untouched.
- **Edited or deleted skills, project overrides, retired skills:** unchanged.
- **Existing skills that miss the format:** keep loading; `alp skill check` and `alp doctor`
  tell you what to change.
- **Teams:** Phở and Cafe are unchanged; Blueprint exists only after
  `alp pack install architecture`.
- Start a new session (or close and resume) to see new skills, agents and teams.
- No protocol change. The run log gains `skill-resource` events; older readers ignore them.

## Provenance

The v2 skills, packs, agents and checker were written for ALP (Apache-2.0). ClaudeKit
Engineer was studied for ideas only; its repository is licensed as proprietary, so nothing
was copied from it (`plans/261105-0213-skill-system-v2/audit.md`).
