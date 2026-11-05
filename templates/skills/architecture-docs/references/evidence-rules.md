# Evidence rules

Read when extracting architecture facts from a repository and citing or marking them.

## Where facts come from
| Fact | Primary evidence |
|---|---|
| Language, runtime, packages | Manifests and lockfiles (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) |
| Runtime units and startup | Entry points (`bin`, `main`, `scripts`), Dockerfiles, process or service config |
| Module boundaries | Workspace config, package exports, directory ownership files, lint import rules |
| Dependencies between modules | Import statements and the build graph; prefer an existing graph tool's output |
| HTTP or RPC surface | Route registration files, OpenAPI or proto files, handler tests |
| Data shapes | Schemas, migrations, type definitions, validators |
| External systems | Client configuration, environment variable reads, deployment manifests |
| Conventions | Repeated patterns in three or more places, lint and format config |
| Decisions | Existing ADRs, commit messages that state a choice, confirmations from the user |

Tests are evidence of intended behaviour; config is evidence of what is deployed only
if the deploy path reads it.

## Extraction steps
1. Start at entry points and follow imports outward; do not start from folder names.
2. Count before generalising: one occurrence is an example, not a convention.
3. Use read-only commands (search, list, the project's own graph or build tools); do
   not install analysers.
4. Record command and result for any non-obvious fact.

## Citation style
- Inline: `The daemon owns session state (packages/daemon/src/sessions.js).`
- With a symbol: `(packages/core/src/tasks.js, createTask)`.
- With lines only when stable: `(src/router.ts:40-62)`.
- Several sources: list the most direct first.
- Relative paths from the repository root; no absolute or machine-specific paths.

## Marking unknowns
- Inline: `Unverified: the worker appears to retry three times (src/worker.js:88); no test covers it.`
- Section end: `Open questions` list, each with who can answer it and what evidence
  would settle it.
- Never upgrade an unverified statement to fact without new evidence.

## Red flags
- A statement with no path, or a path that no longer exists.
- Words like "should", "will", "designed to" describing current behaviour.
- A diagram or module list copied from an older doc without checking the tree.
- Config for a service nothing starts or deploys.
- Conventions documented from a single file or from a style guide the code ignores.
- Names of internal hosts, secrets or customer data: remove them.
