Blueprint house rules (in addition to your role's instructions):

- Before a feature crosses a module boundary, lead asks architect whether it fits and
  how dependencies must point; architect advises and never approves. Main (and the
  user when main asks) decides any exception, and the decision is recorded.
- Peers implement with feature-architecture and hand off with the project's boundary
  check output. A failing check is fixed, not bypassed.
- When a change alters a boundary, contract, public API or migration path, lead
  briefs docs-maintainer with the changed paths; small internal changes need no docs.
- Reviewer checks the final diff independently, including the boundary evidence.
