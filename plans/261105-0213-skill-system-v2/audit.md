# Skill System v2 — Phase 1 audit

Date: 2026-11-05. Branch `claude/nifty-allen-rr9rc6` from `main@bc98e63`.
Reference: `phucanh08/claudekit-engineer@6051503` (shallow clone, read-only).

## 1. Current ALP baseline (verified in code)

| Concern | Where | Behavior today | Gap for v2 |
|---|---|---|---|
| Library | `packages/core/src/library.js` | `$ALP_HOME/{role-skills.json,skills/,library.json}`; `seedLibrary` writes shipped `skills/**` + `providers/**`; `library.json` stores sha per file; replaces only unedited files, never recreates deleted, never touches edited | Shipped files are read/written as UTF-8 text; executable bit not restored (bundles embed templates as JSON strings, `scripts/workspace-build-lib.mjs`) |
| Role offer/upgrade | `offerRoleSkills`, `SHIPPED_ROLE_SKILLS` | Edited `role-skills.json` is offered new built-in pairs once (`roleSkillsOffered`); test `role-skills-offer.test.js` requires current sha listed | New shipped mapping needs a new sha entry |
| Resolution | `packages/core/src/resolver.js` `resolveAgent` | role skills from library → project `.alp/skills/<n>` replaces same name → `agent.json.skills` (project, then library) → agent's own `skills/` dir; sorted | None (keep) |
| Level 0 index | `packages/runtime/src/resolve.ts` `InstructionsAdapter` | Lists `- name (abs path): description` (≤400 chars) for the agent's skills only; bodies not injected | Header says nothing about references on demand / scripts |
| Claude | `claude-transport.ts` `skillPlugin` | Per-session plugin `alp` symlinks each skill dir → native `alp:<name>` Skill tool; whole dir (refs/scripts) visible in place | None |
| Codex / ACP / Antigravity | instructions | Same index in instructions (ACP: sent with first prompt); agent reads files with own tools | None; no native Skill tool emulated |
| Skill use log | `runtime.ts` `skillUse` | Logs first SKILL.md read / Skill call per session+skill (`event: skill`) | No evidence of which references/scripts were opened |
| Authoring | `alp_skill` (runtime) | Supervised main proposes; user approves; writes SKILL.md only; name `[a-z0-9-]`, desc ≤300 | No frontmatter/reference validation |
| Edit CLI | `library-edit.js` | `alp skill new/edit/cp/mv/rm/show`; skill entry = `SKILL.md` only | `cp` drops `references/`, `scripts/`, `assets/` |
| Retire/restore | `alp_skill_retire`, `restoreSkill` | Moves dir to `retired-skills/<name>-<time>/` + `retired.json`; restore moves back (rename preserves bytes/modes) | None |
| Validation | `validation.js`, `doctor.js` | Agent/hook/team/settings schemas; doctor warns on role-skills names without SKILL.md | **No skill validator** (frontmatter, name rules, references, symlinks) |
| Permissions | `permissions.js` `profileFor` | Profiles cap mode; `ADVISORS = oracle, reviewer, supervisor` forced read-only by name; delegated child = requester mode unless asked less or capped by profile | A custom `advisor` member (e.g. `architect`) is **not** read-only unless a profile caps it |
| Hooks | `hooks.js`, `hook-run.js` | `handoff`, `task.close`, `merge` can block; project hooks need workspace trust | Reuse for architecture gates |
| Teams | `templates/teams/{pho,cafe}` | roles lead/peer/advisor/reviewer, delegation DAG, maxPeers | Reuse; add optional team via pack |
| Tests | `integrations/paseo/tests/skills.test.js`, `packages/core/tests/{resolver,library-edit,role-skills-offer}.test.js`, `test/integration/skill-use.test.js` | seeding, precedence, upgrades keep edits, lazy index, description parsing, skill-use logging | Add validator, packaging, packs, role isolation for new skills |

Already satisfied (not re-implemented): Level 0 metadata only for assigned skills, lazy bodies, role isolation, user-edit protection, project overrides, retire/restore, Claude native skills, Codex instruction loading.

## 2. ClaudeKit Engineer audit

### License / provenance (decisive)
- Root `LICENSE`: "Copyright (c) 2024-2025 ClaudeKit. All Rights Reserved … proprietary and confidential. Unauthorized copying … strictly prohibited". Contradicted by `README.md` (MIT) and `package.json` (`MIT`) and per-skill `license: MIT|Apache-2.0` frontmatter — conflicting, so **treated as not permitted**.
- `skill-creator`, `mcp-builder`, `ui-styling` carry Anthropic Apache-2.0 `LICENSE.txt` but are ClaudeKit-modified; `document-skills/*` are Anthropic proprietary; `react-best-practices` is Vercel-origin; several others resemble third-party projects without credit.
- **Decision: nothing is copied.** All ALP content below is written independently; only general ideas (progressive disclosure tiers, evidence-based docs, validator gaps) are used.

### Component verdicts

| Item | Function / trigger | Deps / runtime assumptions | Overlap with ALP | Verdict |
|---|---|---|---|---|
| skill-creator | create/update skills; `quick_validate.py` (name regex, `<>` ban only) | Python; `$HOME/.claude`, Task, AskUserQuestion | `alp_skill`, `curate` | **Core (rewrite)** → `skill-authoring` + ALP validator |
| code-review | review + receiving feedback | Task, chains agents | reviewer role | Reject (reviewer role covers); `security-review` core instead |
| context-engineering | token/context limits | reads Claude OAuth creds | `compact`, ALPD §57 | **Reject** (credential access) |
| planning / cook / fix / debug | mandatory workflows, "ALWAYS activate" | Task chains, slash commands | `sequence-execution-plan`, `bug-loop` | Reject (duplicate; forced triggers) |
| brainstorm / research / scout | ideation / research / search | AskUserQuestion, gemini/opencode CLIs | `goal-griller`, `xia` | Reject (duplicate) |
| backend-development, databases | APIs, auth, DB | optional CLIs | none | **Optional pack `backend` (rewrite)** |
| frontend-development, react-best-practices, web-frameworks | React/Next guidance | none | none | **Optional pack `frontend`**: one `frontend-development` skill with refs |
| web-design-guidelines, ui-ux-pro-max, frontend-design | UI guidance; data CSVs; remote fetch | Python install, WebFetch | none | **Optional pack `design`**: one `ui-design` skill; no data, no fetch |
| web-testing | Playwright/Vitest/k6 | many npx tools | `test-strategy` (method) | **Optional pack `quality`** (tooling only) |
| devops | Cloudflare/Docker/K8s | wrangler, py scripts | none | **Optional pack `operations`** |
| mcp-builder | build MCP servers | `ANTHROPIC_API_KEY`, pip | ALP `mcp/<name>.json` | **Optional pack `integration`** → `mcp-integration` |
| mermaidjs-v11 | diagrams | mermaid-cli | none | Folded into `architecture-docs` reference |
| docs-manager agent + documentation-management rule | evidence-based docs | repomix, hooks | none | **Core skill `architecture-docs`** + agent `docs-maintainer` (pack) |
| code-reviewer, planner, researcher, fullstack-developer, debugger, git-manager, project-manager | agents | Task/subagent_type | main/lead/peer/oracle/reviewer | Reject (roles cover) |
| code-simplifier | refine code | none | — | Reject; `safe-refactor` core covers method |
| tester, ui-ux-designer | agents | — | peer + skills | Reject for now (peer + `test-strategy`/`ui-design`) |
| hooks, rules, install.sh | auto-install (`sudo apt`, curl\|bash), privacy hooks | Claude-only | ALP hooks | **Reject** |

## 3. Compatibility matrix (v2 changes)

| Surface | Change | Compat behavior |
|---|---|---|
| Existing skill paths | none | unchanged |
| User-edited skills | none written | library.json sha guard unchanged |
| User-edited role-skills.json | new pairs offered once on `alp upgrade` | existing `offerRoleSkills` |
| Unedited role-skills.json | replaced with new shipped file | existing sha rule |
| Legacy skills failing strict format | validator reports warnings (legacy mode) | never rewritten or blocked at runtime |
| Project overrides | unchanged | — |
| Retired skills | unchanged | — |
| Skill-use log | adds `skill-resource` events | old readers ignore unknown events |
| Claude / Codex / ACP | header text only | no protocol change |
| Teams pho/cafe | unchanged | new team only via opt-in pack |
| Custom advisors | pack installer adds a read-only permission entry when absent | existing profile enforcement |

## Unresolved questions
- Real-model trigger/execution evals need provider credentials not available in this container (see final report).
