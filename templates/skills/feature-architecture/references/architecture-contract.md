# Architecture contract

Read when the project has `docs/architecture/contract.json`, or wants dependency rules
that a tool checks instead of a reviewer remembering them.

## Prefer the project's own tools

If the project already enforces boundaries (an ESLint boundaries or import rule,
dependency-cruiser, Nx module boundaries, import-linter for Python, ArchUnit for
Java, a custom script like `scripts/check-boundaries.mjs` of its own), use it and
stop here. The contract below is a fallback for JavaScript/TypeScript repositories
that have none. Adopting it is a project decision: propose it, do not add it.

## Format

```json
{
  "description": "Layers of the orders service",
  "modules": {
    "api": ["src/api/**"],
    "app": ["src/app/**"],
    "domain": ["src/domain/**"],
    "shared": ["src/shared/**"]
  },
  "allow": {
    "api": ["app", "shared"],
    "app": ["domain", "shared"],
    "domain": ["shared"],
    "shared": []
  },
  "denyPackages": { "domain": ["express", "pg", "node:fs"] },
  "ignore": ["**/*.test.ts", "**/__fixtures__/**"],
  "exceptions": [
    { "file": "src/domain/legacy-report.ts", "import": "src/api/**",
      "reason": "Report export predates the layering; removed by #412", "approvedBy": "main, 2026-11-05" }
  ]
}
```

- `modules`: name -> globs over repository-relative POSIX paths (`**`, `*`, `?`). A file
  belongs to the first module whose glob matches; files in no module are not checked.
- `allow`: a listed module may import only itself and the modules named. A module not
  listed in `allow` is unrestricted, so list every module you want to constrain.
- `denyPackages`: bare package names (or `node:` builtins) a module must not import.
- `ignore`: files never checked.
- `exceptions`: the escalation record. Each needs `file`, `import` (a glob over the
  imported file or the package name), `reason` and `approvedBy`; the checker refuses
  the contract without them. Add one only after the decision was made by the person
  the rule belongs to, never to make a failing check pass on your own.

## What the checker sees

`node <skill dir>/scripts/check-boundaries.mjs --root <repo> [--contract FILE] [--json]`

- Reads `import ... from`, `export ... from`, side-effect `import '...'`, dynamic
  `import('...')` and `require('...')`, comments ignored, in `.js .jsx .mjs .cjs .ts
  .tsx .mts .cts` files (`.d.ts`, `node_modules`, `dist`, `build`, `coverage` skipped).
- Resolves relative specifiers as Node and TypeScript do (extensions, `index.*`,
  `./x.js` for `./x.ts`). Path aliases (`@/x`, tsconfig `paths`) and computed
  specifiers are not resolved: a project using aliases needs its own tool.
- Exit 0 clean, 1 violations (`file:line  from -> to (specifier): rule`), 2 invalid
  contract or arguments. It only reads files.

## Enforcing it

Only rules the checker verifies reliably belong in a hard gate.

- CI: add the command to the project's CI or test script, with the script copied into
  the repository (for example `tools/check-boundaries.mjs`) so CI needs no ALP library.
- ALP: a blocking hook refuses a handoff, a task close or a merge while the check
  fails; the end of its output is the reason the agent reads. A hook applies to the
  agents that name it, so the user (not the agent) defines it and gives it to them:

```sh
alp hook add architecture --project --event handoff --command "node tools/check-boundaries.mjs" --blocking --timeout 120
alp agent edit peer --project --hooks architecture
alp hook test architecture --project
```

Use `--event task.close` (on main or lead) or `--event merge` for the other gates.
Project hooks run once the user trusts the workspace (`alp trust`).
