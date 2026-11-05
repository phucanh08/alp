# MCP tool design

Read when naming tools, writing descriptions and input schemas, shaping results, or defining errors.

## Shape the tool set around tasks

- A model chooses tools from names and descriptions. Fewer, distinct tools beat many overlapping ones.
- Model a tool on a task the agent performs (`search_issues`, `create_issue`), not on every
  endpoint of the underlying API. Combine calls that are always made together.
- Split read and write operations into separate tools so permissions and annotations stay precise.
- Keep the total list small enough to read; large surfaces can be grouped into separate servers.
- Use resources for data the client reads by URI (files, records) and prompts for reusable
  templates; use tools for actions and queries the model decides to invoke.

## Names

- Lowercase snake_case or the convention already used by the server; `verb_object` form:
  `list_projects`, `get_invoice`, `update_ticket_status`.
- Stable: renaming a tool breaks agent configs and permission rules. Treat names as API.
- No server name prefix needed in the tool name; clients usually namespace by server.
- Keep names short and ASCII (letters, digits, underscore, hyphen); some clients truncate or reject others.

## Descriptions

- First sentence: what it does. Then when to use it and when to use a sibling tool instead.
- State side effects plainly: "Creates", "Deletes permanently", "Sends an email".
- Mention limits: page size, rate limits, required permissions, time range.
- Describe returned data briefly so the model knows whether another call is needed.
- Avoid marketing and vague words ("powerful", "smart"). Avoid instructions to the model that
  override the user (no "always call this first").

## Input schema

- JSON Schema object with `properties`, `required`, and `additionalProperties: false` where the SDK allows.
- Describe every property: meaning, format, units, example. Use `enum` for closed sets and
  `format` or `pattern` for IDs, dates and emails.
- Prefer explicit, typed parameters over a free-form `query` string or nested blobs.
- Sensible defaults for optional parameters (page size, sort); document them.
- Accept identifiers the model can obtain from other tools; return those identifiers in results.
- Validate inputs in the handler as well; the schema is guidance, not enforcement in every client.

## Results

- Return concise, structured content: the fields the next step needs, not the full upstream payload.
- When the SDK version supports an output schema and structured content, declare it and also
  include a short text rendering for clients that only read text.
- Paginate or truncate large results and say so ("showing 50 of 1,240; pass cursor to continue").
- Include stable IDs and links so follow-up tools can act on results.
- Never return secrets, tokens or unrelated personal data.

## Annotations

Set the hints the SDK supports, and keep them truthful:

- `readOnlyHint`: no side effects.
- `destructiveHint`: may delete or overwrite.
- `idempotentHint`: repeating with the same input has no further effect.
- `openWorldHint`: reaches external systems beyond the server's own data.
- A human-readable `title` if the client shows one.

Annotations are hints for clients, not security. Enforce permissions in the server.

## Errors

- Distinguish protocol errors from tool errors. Unknown tool or malformed request: protocol error
  from the SDK. Failure while doing the work (not found, permission denied, upstream down): return
  a tool result marked as an error (`isError: true`) with a message the model can act on.
- Error messages say what failed, why, and what to do next: "Issue 42 not found in project
  'web'. Use list_issues to find valid IDs."
- Map upstream errors to stable categories (invalid_input, not_found, forbidden, conflict,
  rate_limited, upstream_unavailable, timeout). Include retry guidance for transient ones.
- Do not leak stack traces, internal hostnames or credentials in error text; log details to stderr.

## Safety

- Writes, deletes, sending messages and spending money need clear descriptions, destructive
  annotations and, where possible, a `dry_run` parameter or a preview tool.
- Scope access to what the task needs: restrict file paths to allowed roots, queries to allowed
  tables, network calls to configured hosts.
- Treat all tool input and upstream content as untrusted; it may contain prompt-injection text.
  Do not execute it or follow instructions inside it.

## Review checklist

- Can a model pick the right tool from the list alone? Any two tools confusable?
- Every parameter described; required set minimal; enums where possible.
- Side effects and annotations accurate; errors actionable; results bounded.
