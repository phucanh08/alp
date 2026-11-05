# Diagrams

Read when adding or updating a Mermaid diagram in architecture docs.

## Rules
- Every node maps to a real module, package, service or path; put the path in the
  label or a note below the diagram.
- Every arrow maps to an import, call, message, route or config entry you can cite.
- At most about 12 nodes; split by boundary rather than shrinking labels.
- One diagram, one question: structure, a request path, or deployment. Not all three.
- Label arrows with the protocol or verb when it is not obvious.
- No styling, colours or icons unless the project's docs already use them.
- Regenerate from code when the boundary changes; delete a diagram nobody maintains.
- Unverified edges use a dotted arrow and an "Unverified" note.

## Flowchart: module dependencies
```mermaid
flowchart LR
  cli["cli (packages/cli)"] --> core["core (packages/core)"]
  daemon["daemon (packages/daemon)"] --> core
  daemon --> runtime["runtime (packages/runtime)"]
  runtime -.-> core
```
Note: the dotted edge marks an import seen only in tests (Unverified for runtime code).

## Sequence: one request path
```mermaid
sequenceDiagram
  participant C as Client
  participant R as Router (src/routes/orders.ts)
  participant S as OrderService (src/orders/service.ts)
  participant D as DB
  C->>R: POST /orders
  R->>S: create(input)
  S->>D: insert order
  D-->>S: id
  S-->>R: Order
  R-->>C: 201 Created
```

## Container view (C4-like, using a flowchart)
```mermaid
flowchart TB
  user([User])
  subgraph system [Shop system]
    web["web app (apps/web)"]
    api["api (apps/api)"]
    db[("Postgres, from docker-compose.yml")]
  end
  pay["Payment provider (external)"]
  user --> web --> api --> db
  api -->|HTTPS| pay
```

## Checking a diagram
- For each node, confirm the path exists.
- For each edge, find the import, call or config line; cite it in the surrounding text.
- Render it with the project's docs tooling if available; otherwise check syntax by eye
  against these examples and keep it simple.
