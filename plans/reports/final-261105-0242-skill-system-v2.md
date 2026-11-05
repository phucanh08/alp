# Skill System v2 — final report

Branch `claude/nifty-allen-rr9rc6` (base `main@bc98e63`). Audit/plan: `plans/261105-0213-skill-system-v2/`.

## 1. Summary
ALP already had Level 0 metadata, lazy bodies, role isolation, edit-safe library updates, project overrides, retire/restore. v2 adds: Agent Skills validator (strict/legacy), 7 core skills + role mapping v2, resource packaging fixes, on-demand resource logging, 7 optional packs + installer, architect (read-only advisor) / docs-maintainer (peer) / Blueprint team, architecture contract checker + hook gate, evaluation tooling, docs. No new built-in role, no protocol change, no ClaudeKit content (repo licence proprietary).

## 2. Baseline vs changes
| Area | Baseline | v2 |
|---|---|---|
| Validation | none for skills | `skill-validate.js`, `alp skill check`, doctor `skill-format`, `alp_skill` strict |
| Core skills | 8 | 15 (main 15, lead 11, peer 6, reviewer 2) |
| Packaging | shipped scripts lose +x; `skill cp` copies SKILL.md only | +x from `#!`; whole dir copied, links refused, rollback |
| Disclosure evidence | SKILL.md reads logged | + `skill-resource` events (inputs only) |
| Specialists | — | 7 optional packs, never seeded |

## 3. Skills
Added (core): skill-authoring, architecture-docs, feature-architecture (+ `scripts/check-boundaries.mjs`), test-strategy, safe-refactor, security-review, release-readiness. Existing 8 unchanged.
Pack skills: backend-development, databases, frontend-development, web-testing, ui-design, mcp-integration, devops.
Rejected: cook/fix/debug/planning/brainstorm/research/scout (duplicate ALP skills), context-engineering (reads OAuth creds), code-review/reviewer agents (roles cover), ui-ux-pro-max data (licence/data), install scripts.

## 4–5. Packs and agents
backend, frontend, quality, design, integration, operations, architecture (architect, docs-maintainer, blueprint). `alp packs`, `alp pack install <id> [--project] [--assign]`. Architect capped read-only via `permissions.agents` added only when absent and only for an agent the pack installed.

## 6. Runtime changes
`resolve.ts`: one header sentence. `runtime.ts`: `alp_skill` strict check; `skillResources` logging. `session-state.ts`: one field. No transport/protocol change.

## 7. Progressive disclosure evidence (measured, `scripts/skill-eval.mjs disclosure`)
| Role | skills before/after | index chars before/after | not loaded after |
|---|---|---|---|
| main | 8/15 | 2751/5873 | 109 KB |
| lead | 5/11 | 1847/4546 | 88 KB |
| peer | 3/6 | 1247/2589 | 51 KB |
| reviewer | 0/2 | 0/1264 | 19 KB |
Bodies in instructions: 0 for every role. Main +~780 tokens (estimate chars/4). Tests: skill-eval, skill-use (refs logged on demand, never preloaded), paseo skills (lazy index), acp (index in first prompt, no body, no fake Skill tool).

## 8. Architecture compliance evidence
`test/fixtures/architecture-app` + `test/integration/architecture-contract.test.js`: clean boilerplate passes; feature from template passes; deliberate domain→api import and `express` in domain caught with file:line; exception needs reason+approvedBy; checker as blocking hook. `hooks.test.js`: real runtime refuses peer handoff with the violation as reason, accepts after fix. `packs.test.js`: Blueprint main→architect delegation asking workspace-write runs read-only.

## 9. Automated tests (actual)
Full `npm test` on pushed feature commits: 2414 tests, 2380 pass, 7 fail, 27 skipped. Baseline `main` run: 2388 tests, 2354 pass, same 7 fail. The 7 are environmental: `/tmp/.alp` pre-existing in container (panel 665), chmod-based failure injection ineffective as root (configure ×2, supervisor retirement), process-group kill tests (files, git, terminals). After review fixes, affected files rerun: 148 tests, 147 pass, 1 fail (the root/chmod one). `check`, `check:core`, `check:boundaries`, `release:pack-check`, `skill-check` (22 skills, 0 errors) pass.

## 10. Real-model E2E
Not run. `scripts/skill-eval.mjs triggers --live` (Claude API) and execution fixtures need credentials/approval to spend; Codex CLI absent; ACP verified with the fake ACP agent only. Static scenario checks (15 scenarios, 5 kinds) pass.

## 11. Compatibility/migration
Unedited role-skills.json replaced; edited offered new pairs once (`roleSkillsOffered`); user skills never rewritten; legacy skills load (warnings); project overrides, retired skills, teams Phở/Cafe unchanged. Docs: `docs/alp/skill-system.md`.

## 12. Risks / follow-ups
- Main index +~780 tokens; revisit if trigger evals show over-selection.
- Live trigger/execution evals pending credentials.
- Custom advisors outside packs still need a permission entry to be read-only (by design: ADVISORS are by name).
- check-boundaries does not resolve path aliases (documented; use project tool).

## Unresolved questions
- Run `--live` trigger eval (cost) — user approval needed.
- Should legacy mode treat a plain `../` reference as error? Chosen: warning.
