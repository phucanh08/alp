---
name: mcp-integration
description: "Design, build, test and wire Model Context Protocol servers and clients: tool names, schemas, descriptions and errors, stdio or streamable HTTP transport, remote auth, and ALP configuration. Use when creating or changing an MCP server or connecting one to an agent. Not for general REST API design (backend work) or choosing skills."
---

# MCP servers and clients

## When to use

- Designing or changing the tools, resources or prompts an MCP server exposes.
- Implementing a server or client with the official MCP SDK of the project's language.
- Choosing a transport (stdio or streamable HTTP) or adding auth to a remote server.
- Testing a server by hand or with automated tests.
- Making an existing server available to ALP agents.

## Not for

- Designing a plain HTTP or RPC API with no MCP layer.
- Using an already configured MCP server's tools during ordinary work.
- Deploying a remote server or provisioning its hosting: that needs explicit authorization (see devops).

## Prerequisites

- Read ALP.md and the project's manifests, lockfile and existing MCP code. Use the official
  MCP SDK for the project's language at the version already pinned; read that version's docs
  before relying on an API, since SDK surfaces change between releases.
- Know who calls the server (which agents, local or remote) and what it may touch
  (files, network, accounts). Missing decisions route upward.

## Workflow

1. Define the job: the user tasks the server enables, the systems it reaches, and whether each
   operation reads, writes or deletes. Prefer fewer, task-shaped tools over a mirror of every endpoint.
2. Design tools: name, description, input schema, output, annotations and error behavior. Review
   the set as a model would see it: can it pick the right tool from names and descriptions alone?
3. Choose the transport. stdio for a local process launched per client; streamable HTTP for a
   shared or remote service. Remote servers need auth and origin checks.
4. Implement with the SDK: initialization, capability declaration, handlers with input validation,
   timeouts, pagination for large lists, logs to stderr (never stdout on stdio).
5. Test: manual protocol checks, automated tests that call each tool through a client, error
   and edge cases, then `alp mcp test <name>` once configured.
6. Wire into ALP (below), name it in the agents that need it, and confirm the agent sees the tools.
7. Hand off: tools added or changed, schemas, transport, config entry, test commands and results,
   and any secret the owner must provide.

## Wiring a server into ALP

- One server per file: `mcp/<name>.json` in the user library (`~/.alp`) or a project's `.alp/mcp/`.
  The form is one `.mcp.json` entry: `{ "command", "args", "env", "cwd" }` for stdio, or
  `{ "url", "headers" }` for HTTP. A relative `cwd` is relative to the file's directory.
- Create it with `alp mcp add <name> --command C --arg A [--env K=V] [--cwd D]` or
  `alp mcp add <name> --url U [--header K=V]`; add `--project` for the project layer.
- An agent uses it by naming it in `agent.json`: `"mcp": ["<name>"]`. A library agent can name only
  library servers; a project agent can name project and library ones. A name also present in the
  agent's own `.mcp.json` is an error.
- `alp mcp test <name>` starts the server, lists its tools and stops it. `alp mcp show <name>`
  shows the entry that applies and where it comes from.

## Constraints

- Follow the project's existing stack, SDK and conventions first. Do not add dependencies,
  services or cloud resources without the owner's decision. No auto-install.
- Never put secrets in committed files, including `.alp/mcp/*.json` in a repository. Values in
  `env` and `headers` are used as written, so keep secret-bearing entries in the user library or
  have the server read a credential the owner supplies outside the repository. Do not read or print
  existing secrets.
- Never deploy, change infrastructure, or touch production systems or credentials without
  explicit authorization.
- Tools that write, delete or spend money must say so in their description and annotations,
  and should support a dry run or confirmation step where the SDK and client allow.
- Read-only agents design and review; they do not edit code or ALP config.

## Verification

- Every tool has a clear name, a description stating when to use it, a strict input schema and
  documented errors; destructive tools are marked.
- Automated tests call each tool through an SDK client and cover success, invalid input and a
  downstream failure.
- A stdio server prints nothing but protocol messages on stdout.
- `alp mcp test <name>` lists the expected tools.

## Failure handling

- `alp mcp test` fails to start: run the configured command directly, check `cwd`, the interpreter
  path and stdout pollution; report the exact error.
- Tools missing or renamed: compare the server's tool list with the agent's config and
  check for duplicate server names across layers.
- Auth unavailable: stop at a working unauthenticated local test and report the credential the
  owner must provide; never paste tokens into chat or files.
- SDK API differs from examples: trust the installed version's docs and source; record the version.

## References

- [references/tool-design.md](references/tool-design.md) — read when naming tools, writing descriptions and schemas, or defining errors in step 2.
- [references/server-implementation.md](references/server-implementation.md) — read when choosing a transport, adding auth, or implementing lifecycle, logging, timeouts and pagination in steps 3-4.
- [references/testing.md](references/testing.md) — read when testing a server manually or automatically in step 5.
