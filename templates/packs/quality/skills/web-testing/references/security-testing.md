# Security Testing Basics

Read when running dependency audits, header checks, or auth flow tests.

This covers safe, routine checks in test environments. A security review of code or
design belongs to security-review. Exploit development, penetration testing, and
scanning of systems you do not own are out of scope.

## Authorization and safety

- Test only environments the owner authorized: local, CI, or a dedicated test
  deployment. Never production or third-party systems without explicit written
  authorization naming the target and allowed checks.
- Use only test accounts and synthetic data. Do not read, print, or store secrets,
  tokens, or real personal data.
- Use non-destructive checks. Do not run aggressive scanners, fuzzers, or
  brute-force tools unless the owner authorized them for that target.
- If a check uncovers a real vulnerability, stop exploring it, record minimal
  reproduction steps, and report it upward privately; do not paste exploit details
  or secrets into shared logs.

## Dependency audit

- Run the package manager's built-in audit (for example `npm audit`, `pnpm audit`,
  `pip-audit`, `govulncheck`) or the scanner the project already uses. Do not
  install a new scanner without a decision.
- Report: package, installed version, advisory, severity, whether the vulnerable
  code path is reachable if known, and the fixed version.
- Do not run automatic fix commands that upgrade dependencies; upgrades are a
  separate, owner-approved change with their own tests.
- Note dev-only dependencies separately from runtime ones.

## HTTP header checks

Request key pages and API responses from the test environment and check:

- `Strict-Transport-Security` on HTTPS responses.
- `Content-Security-Policy` present and without broad `unsafe-inline` or wildcard
  script sources, per project policy.
- `X-Content-Type-Options: nosniff`.
- Framing control: CSP `frame-ancestors` or `X-Frame-Options`.
- `Referrer-Policy` set.
- Cookies for sessions: `Secure`, `HttpOnly`, and an appropriate `SameSite`.
- CORS: no wildcard origin with credentials; allowed origins match the intended
  list.
- No version-revealing headers or stack traces in error responses.

Write these as automated tests (e2e or API tests) when the project wants them kept.

## Authentication flow tests

- Unauthenticated access to protected pages and APIs is rejected or redirected.
- User A cannot read or change user B's resources by changing an ID (IDOR).
- A user without a role cannot reach admin pages or call admin APIs directly, not
  only through hidden buttons.
- Logout invalidates the session; the old session cookie or token stops working.
- Expired or tampered tokens are rejected.
- Password reset tokens are single use and expire.
- Login and reset endpoints rate-limit repeated attempts (test with a small number
  of requests, not a brute-force run).
- Error messages do not reveal whether an account exists, per project policy.
- State-changing requests require CSRF protection when cookies authenticate.

## Input handling checks

- Reflected user input is escaped in rendered pages (submit a harmless marker such
  as a string with angle brackets and quotes, and check it renders as text).
- File uploads reject disallowed types and oversized files.
- Redirect parameters only accept allowed destinations.
- API rejects unexpected fields that could set privileged attributes.

## Reporting

- Environment tested and the authorization for it.
- Each check: pass, fail, or not run with the reason.
- Findings with severity, affected endpoint or page, minimal reproduction, and a
  suggested owner (backend-development, frontend-development, or security-review).
- Dependency advisories with upgrade paths, without applying them.
