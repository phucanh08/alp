# @anhlp/alp-protocol

ALP JSON-RPC protocol v1: JSON Schemas, portable session/event DTOs, wire constants, a dependency-free
schema checker, golden fixtures and a conformance runner. No Node, runtime or provider dependencies in
the public contract (the conformance runner alone uses `node:net`).

- Specification: [docs/protocol/alp-json-rpc-v1.md](../../docs/protocol/alp-json-rpc-v1.md)
- Client integration: [docs/protocol/v1-client-integration.md](../../docs/protocol/v1-client-integration.md)
- Normative schema: `schema/methods-v1.json` (methods, errors, capabilities, definitions); messages: `schema/ipc-v1.json`
- Golden values: `fixtures/v1/cases.json` (`node scripts/fixtures.mjs` writes it)
- Conformance: `node conformance/run.mjs --socket <path> [--profiles …]` against any implementation (from a source checkout, build the package first: `pnpm --filter @anhlp/alp-protocol run build`; the runner imports `dist/contract.js`)

After editing `schema/methods-v1.json`, run `pnpm --filter @anhlp/alp-protocol run generate` (a test fails while `src/contract-v1.ts` is stale).

Build: `pnpm --filter @anhlp/alp-protocol run build`. Test: `pnpm --filter @anhlp/alp-protocol run test`.

Public imports use the package root and its explicitly exported subpaths. See [architecture, provider extension, compatibility and release instructions](../../docs/modular-monorepo.md).
