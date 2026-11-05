# Frameworks, Rendering, and Routing

Read when choosing SSR, SSG, or CSR, server or client components, or routing
placement.

Framework conventions change between major versions. Identify the exact framework
and version from `package.json` and the lockfile, follow the conventions that
version uses, and check its official docs (or the installed package's docs and
types) before relying on an API. If the project mixes old and new conventions (for
example a pages router and an app router), follow the one used by the area you are
changing and do not migrate it unasked.

## Rendering modes

| Mode | Renders | Good for | Costs |
| --- | --- | --- | --- |
| CSR (client-side) | in the browser | app-like screens behind login | slower first paint, SEO depends on crawler |
| SSR (per request) | on the server each request | personalized or fresh content, SEO | server cost, latency per request |
| SSG (build time) | once at build | stable content, docs, marketing | rebuild or revalidate to update |
| Incremental / revalidated static | at build, refreshed on a schedule or trigger | mostly static content that changes | staleness window |
| Streaming / partial | server streams parts as ready | slow sections on fast shells | more complex loading states |

- Match the mode the surrounding routes use unless the brief requires a change.
- Changing the rendering mode of a route affects caching, hosting, and SEO; route
  that decision upward.

## Server and client components

Applies to frameworks with a server/client split (React Server Components in
Next.js app router and similar; analogous concepts in Nuxt, SvelteKit, Astro islands).

- Server components: fetch data, read server-only config, render static markup,
  ship no component JS. They cannot use client state, effects, or browser APIs.
- Client components: interactivity, state, effects, browser APIs. Mark them as the
  framework requires (for example a `"use client"` directive) as low in the tree as
  possible so most markup stays server-rendered.
- Props passed from server to client must be serializable; do not pass functions or
  class instances.
- Never import server-only modules (database clients, secrets) into client code.
  Use the framework's server-only guard if it has one.
- Server actions or form actions are public endpoints: validate input and check
  authorization in them as in any API.

## Hydration

- Server and client must render the same initial markup. Avoid render-time use of
  `Date.now()`, random values, `window`, or locale-dependent formatting without a
  stable input.
- Read browser-only values after mount, or render them only on the client through
  the framework's mechanism.
- Treat hydration warnings as bugs.

## Routing conventions

- Follow the project's routing system: file-based (Next.js, Nuxt, SvelteKit, Remix
  or React Router framework mode) or config-based (React Router, Vue Router).
- Put data loading where the framework expects it (loaders, server components,
  `load` functions, route guards) to avoid client waterfalls.
- Use the framework's link component for internal navigation so prefetching and
  client transitions work.
- Use route-level loading, error, and not-found handling that the framework provides.
- Keep URL state (filters, pagination, tabs) in params or query strings.
- Protect routes on the server (middleware, loaders) as well as in the UI; client
  redirects alone do not secure data.

## Environment and config

- Public env variables (prefixes such as `NEXT_PUBLIC_` or `VITE_`) are embedded in
  the client bundle; never put secrets in them.
- Respect the project's build output (static export, Node server, edge runtime);
  runtime APIs differ between them.

## When unsure

- Find the closest existing route that does the same kind of thing and mirror it.
- If docs for the installed version contradict memory or examples, follow the docs
  and note the difference in the handoff.
