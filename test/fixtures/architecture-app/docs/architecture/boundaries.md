# Boundaries

Enforced by `docs/architecture/contract.json`:
- api -> app, shared
- app -> domain, shared
- domain -> shared only; no framework or database packages (express, pg).
