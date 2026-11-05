# Testing an MCP server

Read when checking a server by hand, writing automated tests for its tools, or confirming it
works inside ALP.

## Order

1. Unit tests for the logic behind each tool, without the protocol.
2. Protocol tests: an SDK client connected to the server over an in-memory or stdio transport.
3. Manual inspection of the tool list and a few calls.
4. ALP check with `alp mcp test <name>` and one agent run that uses a tool.

Run the project's existing test command; add tests in its framework and layout.

## Manual checks (inspector style)

Use an interactive MCP inspector only if the project or owner already has one available;
fetching one through a package runner downloads code and needs the owner's approval. Otherwise
a short SDK client script in scratch space does the same job.

Check:

- Initialization succeeds; server name, version and declared capabilities are right.
- `tools/list` returns every expected tool with descriptions, input schemas and annotations.
- Each tool: one valid call, one call with a missing required field, one with a wrong type,
  one that triggers a downstream failure (not found, permission denied).
- Error results are tool errors with actionable messages, not crashes or protocol errors.
- Large lists paginate: `nextCursor` appears, the next page differs, the last page has none.
- stdio: run the server command directly and confirm nothing but JSON-RPC appears on stdout
  (startup banners and warnings must go to stderr).
- HTTP: requests without valid auth are rejected; wrong `Origin` is rejected; the server
  does not listen on all interfaces when it is meant to be local.

## Automated tests

- Start the server in-process with the SDK's in-memory transport when available, or spawn the
  stdio command; connect an SDK client; call tools through the client.
- Assert on structure, not exact prose: tool names, schema required fields, result fields,
  `isError` flag and error category.
- Snapshot the tool list (names, required parameters, annotations) so accidental renames or
  schema changes fail a test. Update the snapshot deliberately.
- Replace upstream services with fakes at the HTTP or client boundary; do not call production
  APIs or use real credentials in tests.
- Cover timeouts and cancellation with a fake upstream that delays.
- For destructive tools, test the dry-run path and that the real path requires the expected input.
- Clean up child processes and temporary files in teardown; a leaked server process hangs CI.

Minimal test outline:

```text
setup:    start server (in-memory or spawn), create client, initialize
test:     tools/list contains expected names and required params
test:     call get_item {id: known}   -> result with id, no isError
test:     call get_item {id: missing} -> isError, message mentions not found
test:     call get_item {}            -> invalid input error
test:     list_items paginates with cursor
teardown: close client, stop server
```

## Checking inside ALP

- Configure the server: `alp mcp add <name> --command C --arg A` (stdio) or
  `alp mcp add <name> --url U --header K=V` (HTTP); add `--project` for the project layer.
- `alp mcp test <name>` starts the server, prints its name, version and tool list, and stops it.
  A failure here usually means a wrong command or `cwd`, missing environment variables, stdout
  pollution, or a slow startup.
- `alp mcp show <name>` confirms which layer's entry applies.
- Name the server in the agent's `agent.json` (`"mcp": ["<name>"]`) and run a short task that
  uses one read-only tool; confirm the call and result in the session log.
- Never put real tokens in a committed config to make a test pass; report the missing credential.

## What to report

Commands run and their output (test command, `alp mcp test`), tools verified, cases not covered
and why (for example: no credentials for the remote API), and any schema changes that affect
existing agents.
