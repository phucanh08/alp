# MCP server implementation

Read when choosing a transport, adding auth to a remote server, or implementing lifecycle,
logging, timeouts and pagination.

## Use the official SDK

- Use the official MCP SDK for the project's language at the version already pinned. Check that
  version's docs and changelog: transport classes, registration helpers and result types differ
  between releases and protocol revisions.
- Adding the SDK, upgrading it, or adding a web framework for HTTP is a dependency decision for
  the owner. Do not install anything automatically.
- Let the SDK handle JSON-RPC framing, initialization and protocol version negotiation. Do not
  hand-roll the protocol.

## Transports

| | stdio | Streamable HTTP |
|---|---|---|
| Process | Client launches the server as a child process | Long-running service, many clients |
| Fit | Local tools, per-user access to local files or CLIs | Shared or remote services, hosted integrations |
| Messages | Newline-delimited JSON-RPC on stdin/stdout | JSON-RPC over HTTP POST to one endpoint; responses as JSON or an SSE stream |
| Auth | Inherits the user's environment | Required for anything non-local |
| ALP config | `{ "command", "args", "env", "cwd" }` | `{ "url", "headers" }` |

- The older HTTP+SSE transport is deprecated; support it only if an existing client needs it.
- stdio: stdout carries protocol messages only. Any stray print, banner, progress bar or library
  warning on stdout corrupts the stream. Send logs to stderr.
- Streamable HTTP: validate the `Origin` header to prevent DNS rebinding, bind local-only servers
  to `127.0.0.1` rather than all interfaces, and handle session IDs as the SDK documents.
  Keep the endpoint path stable; clients store the URL.

## Lifecycle

1. Initialize: client sends its protocol version and capabilities; server answers with its
   version, capabilities (tools, resources, prompts, logging) and server info (name, version).
2. Initialized notification; normal operation begins. Do not send requests before it.
3. Operation: handle `tools/list`, `tools/call` and any other declared capabilities. Emit
   `list_changed` notifications only if declared and the tool set really changes.
4. Shutdown: for stdio, exit cleanly when stdin closes; for HTTP, release session state.
   Flush logs, close upstream connections and child processes.

- Start fast. Defer slow work (connecting to upstream, loading indexes) until first use so
  `tools/list` responds quickly; clients and `alp mcp test` time out on slow starts.
- Fail at startup with a clear stderr message if required configuration is missing.

## Configuration and secrets

- Read configuration from environment variables or arguments; document each one.
- Never commit secrets. ALP passes `env` and `headers` values as written, so a project-level
  `.alp/mcp/<name>.json` must not contain tokens. Keep secret-bearing entries in the user library
  or have the owner supply the credential outside the repository.
- Never log secrets or full request bodies that may contain them.

## Auth for remote servers

- Follow the authorization part of the MCP specification for the protocol revision in use
  (OAuth 2.1 based, with protected resource metadata). Use the SDK's or framework's auth helpers
  rather than custom token parsing.
- Validate tokens on every request: issuer, audience (the token must be meant for this server),
  expiry and scopes. Reject tokens issued for other services.
- Do not pass the client's token through to upstream APIs; obtain separate upstream credentials.
- Map scopes to tools; check authorization per tool call, not only at connection.
- Rate limit per client and return a clear error when limits are hit.
- Hosting, DNS, certificates and identity provider setup are infrastructure changes that need
  explicit authorization.

## Timeouts, cancellation and progress

- Put a timeout on every upstream call shorter than the client's request timeout, and return a
  tool error naming the timeout.
- Honor cancellation notifications: stop work and release resources.
- For long operations, report progress if the client sent a progress token, or split into
  start and status tools.
- Limit concurrency to protect upstream services.

## Pagination and size

- List operations (`tools/list`, `resources/list`, and list-style tools) use opaque cursors:
  return `nextCursor` when more results exist; accept `cursor` on the next call.
- Cursors are opaque strings; do not let clients depend on their format.
- Cap result sizes. Large blobs belong in resources or files referenced by URI, not inline text.

## Logging

- stderr for stdio servers; structured lines (level, time, tool, duration, error category).
- Optionally implement the protocol's logging capability so clients can receive log messages.
- Log tool name, duration and outcome for each call; omit argument values that may be sensitive.

## Client side

- When writing a client, use the same SDK: connect a transport, initialize, list tools, call
  tools, handle `isError` results separately from protocol errors, and close the session.
- Cache tool lists only until a `list_changed` notification or reconnect.
