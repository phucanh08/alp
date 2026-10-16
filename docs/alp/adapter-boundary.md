# Adapter boundary

> Written in an early phase, when core lived in `src/core`. The contract still holds; the files
> are now `packages/core/src/types.d.ts` and `packages/core/src/adapter.d.ts`, and settings
> accept much more than listed below (see [team-workflow.md](team-workflow.md)).

`src/core/types.d.ts` defines the serializable `ResolvedAgent`; `adapter.d.ts` defines the compile-only adapter contract. `compileAgent()` validates IR and capabilities, hands a copy to the adapter, and checks its compiled envelope. Lifecycle belongs to the runtime integration, not this contract. Core imports only Node builtins and core modules.

Capabilities use `native` (the host directly supports the feature), `emulated` (the adapter translates it), or `unsupported` (compilation rejects agents that require it). An adapter must not silently discard required resources. Capability claims describe the concrete implementation, not future goals.

The fake adapter composes project instructions before agent instructions, preserves lazy skill references and MCP configuration as test material, and rejects hooks. It launches nothing. Tests compile both `main` and a custom agent without any installed provider package.

Settings currently accept `defaultAgent` and `runtime: { provider?, model?, reasoning? }`. Missing settings fall back to `main`; a configured but missing agent is an error. `ALP.md`, skills, hooks, and `.mcp.json` are optional; `AGENT.md` is required. Skill discovery checks for `SKILL.md` without reading its body. Hook files are discovered but not executed by core.

MCP supports a `mcpServers` map with command/args/cwd/env or HTTP(S) url/headers. Relative cwd and explicit command paths resolve against the agent directory; bare executable names retain PATH semantics. Unsupported MCP fields are rejected. Runtime adapters must state any additional limits.

Today: `npm test -w @anhlp/alp-core` (`packages/core/tests/adapter.test.js`), on Node 22 (22.12 or later) or 24. At the time of writing: `node --test` ran the JavaScript directly on Node 20 with no install/build step, because the local npm 12 warned that Node 20.13.1 was outside its supported range. Node 20 is no longer supported.
