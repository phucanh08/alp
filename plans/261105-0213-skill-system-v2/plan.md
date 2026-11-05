# Skill System v2 — plan

Audit: [audit.md](audit.md). Principle: reuse library/resolver/hooks/profiles; change runtime only where evidence shows a gap.

| # | Task | Owned paths | Depends | Acceptance | Verify |
|---|---|---|---|---|---|
| 1 | Audit + compat matrix | `plans/261105-0213-skill-system-v2/` | — | audit lists baseline, verdicts, license | review |
| 2 | Skill validator (strict/legacy), `alp skill check`, `alp_skill` strict check, doctor warning | `packages/core/src/skill-validate.js`, `packages/cli/src/library.js`, `packages/runtime/src/runtime.ts` (skillTool), `packages/client/src/doctor.js` | 1 | errors vs warnings; name/dir, YAML, refs, traversal, symlinks; shipped skills pass strict | `node --test packages/core/tests/skill-validate.test.js` |
| 3 | Packaging/disclosure: shebang scripts executable on seed; `skill cp` copies whole dir; resource-use log; index header | `library.js`, `library-edit.js`, `runtime.ts` (skillUse), `resolve.ts` | 2 | bytes+modes kept; refs/scripts never injected | unit tests |
| 4 | 7 core skills + role mapping | `templates/skills/*`, `templates/role-skills.json`, `SHIPPED_ROLE_SKILLS` | 2 | strict-valid; roles see only theirs | skills tests |
| 5 | Architecture contract checker | `templates/skills/feature-architecture/scripts/`, `test/fixtures/architecture/` | 4 | violation caught, valid passes, hook blocks | integration test |
| 6 | Optional packs + installer + agents/team | `templates/packs/**`, `packages/core/src/packs.js`, CLI | 2,4 | not seeded; install never overwrites; architect read-only | packs tests |
| 7 | Evaluation | `test/evals/skills/`, `scripts/skill-eval.mjs` | 4,6 | static trigger checks + measured disclosure; live runner skips without creds | run script |
| 8 | Docs + migration | `docs/alp/*.md` | all | guides updated | links checked |

Role mapping decision (context cost measured in task 7):
- main +7: skill-authoring, architecture-docs, feature-architecture, test-strategy, safe-refactor, security-review, release-readiness
- lead +6: same minus skill-authoring
- peer +3: feature-architecture, test-strategy, safe-refactor
- reviewer +2: security-review, release-readiness (read-only methods)
- oracle, supervisor: none
