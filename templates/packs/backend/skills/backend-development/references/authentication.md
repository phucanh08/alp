# Authentication and Authorization

Read when touching login, sessions, tokens, OAuth/OIDC, password storage, or
permission checks.

Use the project's existing auth library or provider. Writing new cryptography,
session handling, or token parsing by hand is out of scope; propose a vetted
library to the owner instead. Auth changes deserve a security-review pass.

## Sessions vs tokens

| | Server-side session | Self-contained token (for example JWT) |
| --- | --- | --- |
| State | Session record in a store; cookie holds an ID | Claims in the token; verified by signature |
| Revocation | Delete the record | Hard; needs short expiry, deny list, or refresh rotation |
| Fit | Browser apps on one site | Service-to-service, APIs used by many clients |

- Browser sessions: cookie with `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`,
  a bounded lifetime, and a new session ID after login or privilege change.
- Cookie-authenticated state-changing requests need CSRF protection (SameSite plus a
  token or origin check, per project convention).
- Tokens: verify signature, algorithm (never accept `none` or an unexpected
  algorithm), issuer, audience, and expiry on every request. Keep access tokens
  short-lived; rotate refresh tokens and detect reuse.
- Do not store tokens in places readable by injected scripts if the project can use
  HttpOnly cookies instead.

## Password storage

- Hash with a slow, salted password hash: Argon2id, scrypt, or bcrypt, through the
  project's existing library. Never a fast hash (MD5, SHA-1, plain SHA-256), never
  reversible encryption.
- Compare with the library's verify function (constant time).
- Rehash on login when parameters are raised.
- Rate-limit login and reset endpoints; return the same response for unknown user
  and wrong password.
- Reset tokens: random, single use, short expiry, stored hashed.

## OAuth 2.0 and OIDC (high level)

- Web and mobile sign-in: authorization code flow with PKCE. Validate `state`
  (CSRF) and, for OIDC, `nonce`. Do not use the implicit flow.
- Service-to-service: client credentials flow with scoped credentials from config.
- OIDC ID tokens identify the user to the client; access tokens authorize API calls.
  Do not use an ID token as an API access token.
- Register exact redirect URIs; never accept a redirect target from user input
  without an allowlist.
- Map external identities to local users by the provider's stable subject ID plus
  issuer, not by email alone.

## Authorization placement

- Authenticate at the edge (middleware or equivalent) and attach an identity to the
  request context.
- Authorize where the resource is known: after loading it, check the caller may act
  on that specific record (owner, tenant, role, or policy). A route-level role check
  alone does not stop access to another user's record (IDOR).
- Scope queries by tenant or owner in the data access layer when the project is
  multi-tenant, so an omitted check fails closed.
- Deny by default. New endpoints without an explicit policy must not be reachable.
- Keep policy checks in one place the project already uses (a policy module,
  decorator, or guard) rather than scattered conditionals.
- Background jobs and internal calls act with an explicit identity or service
  account; record it in audit logs where the project keeps them.

## Secrets and config

- Signing keys, client secrets, and pepper values come from the project's secret
  mechanism. Do not read, print, or commit their values; tests use dedicated test
  keys or fakes.
- Never log credentials, tokens, session IDs, or reset links.

## Checks to add

- Unauthenticated request is rejected (401).
- Authenticated user without permission is rejected (403 or 404).
- User A cannot read or modify user B's resource.
- Expired, tampered, or wrong-audience token is rejected.
- Logout or revocation actually ends access.
