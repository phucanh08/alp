# Security Review Checklist

Read when walking the review categories; check only the categories the target touches.

## Authentication

- Every entry point that should require identity checks it, including new routes,
  RPC handlers, websocket upgrades, CLI daemons, and admin or debug endpoints.
- Tokens and sessions: signature verified, expiry enforced, revocation honored,
  algorithm fixed (no "none" or caller-chosen algorithm).
- Credential comparison is constant-time; password storage uses a slow salted hash.
- Login, reset, and token endpoints resist enumeration and brute force.

## Authorization and permission boundaries

- Checks happen server-side on every request, not only in the UI or client.
- Object-level checks: the caller owns or may access the specific record ID.
- Role or scope checks cannot be bypassed by alternate routes, batch endpoints,
  or parameter tampering (mass assignment of `role`, `owner`, `isAdmin`).
- Privileged operations (delete, export, impersonate, config change) are gated.
- Default is deny; new features do not inherit broad permissions by accident.

## Secrets exposure

- No credentials, keys, or tokens committed in code, config, fixtures, or docs.
  Report path:line only; do not reproduce the value.
- Secrets not returned in API responses, error messages, or client bundles.
- Secrets come from the project's established mechanism (env, vault, keychain).

## Input validation and injection

- SQL/NoSQL: parameterized queries; no string-built queries from input.
- Command injection: no shell strings built from input; argument arrays used.
- Template, HTML, and markdown output escaped by context (XSS).
- Path, URL, header, regex (ReDoS), XML (XXE), and LDAP inputs validated.
- Validation at the trust boundary, with allowlists over denylists.

## Dependency and supply-chain risk

- New dependencies: necessary, maintained, reputable, license-compatible.
- Install scripts (`preinstall`, `postinstall`, build hooks) in new or updated deps.
- Lockfile changes match the manifest change; no unexplained registry or source URL.
- Versions pinned or ranged per project policy; no git or tarball URLs without reason.
- Existing audit tool output for the changed packages, if allowed to run.

## Unsafe filesystem operations

- Path traversal: user-controlled paths normalized and confined to a base dir.
- Symlinks: following a link cannot escape the base dir or overwrite targets.
- Temp files created with unique names and restrictive permissions; cleaned up.
- File modes on written secrets and configs are not world-readable.
- Archive extraction checks entry paths (zip slip) and sizes.

## Remote execution boundaries

- Spawned processes: fixed executable, argument array, no shell unless required,
  controlled env and cwd.
- No `eval`, `Function`, dynamic `require`/`import` of input-derived names.
- Deserialization of untrusted data uses a safe format or schema validation.
- SSRF: outbound URLs from input are allowlisted; internal and metadata addresses
  blocked; redirects re-checked.
- Plugins, hooks, or scripts loaded from user-writable locations are trusted
  explicitly, not implicitly.

## Logging of sensitive data

- Logs, traces, and error reports omit passwords, tokens, keys, session IDs,
  and personal data, or redact them.
- Request/response dumps and debug modes are off by default and not enabled in
  production config.
- Log injection: newline and control characters from input are escaped.
