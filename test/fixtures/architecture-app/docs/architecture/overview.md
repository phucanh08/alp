# Overview

Four modules (src/api, src/app, src/domain, src/shared). Requests enter in `src/api`
handlers, call `src/app` use cases, which use `src/domain` entities. Evidence:
`src/api/orders.ts`, `src/app/place-order.ts`, `src/domain/order.ts`.
