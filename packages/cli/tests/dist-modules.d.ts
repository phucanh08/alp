// Types for the build output these tests import that has no declaration file: the dashboard's per-file JavaScript (dist/dashboard/,
// bundled into alp-dashboard.js, so scripts/build-workspace.ts emits no declarations for it).
// Unbuilt, tsconfig.json's rootDirs already types `../dist/x.js` against the source x.ts; once built, that
// .js without a .d.ts would win and type as nothing, so `pnpm run check` would depend on whether a build
// ran. Each module is declared here with the type of the source it is built from (as test/dist-modules.d.ts
// does for the root tests). One entry per module the tests import, in path order.
declare module '*/dist/dashboard/grant.js' { const m: typeof import('../src/dashboard/grant.ts'); export = m; }
declare module '*/dist/dashboard/owner/host.js' { const m: typeof import('../src/dashboard/owner/host.ts'); export = m; }
declare module '*/dist/dashboard/owner/index.js' { const m: typeof import('../src/dashboard/owner/index.ts'); export = m; }
declare module '*/dist/dashboard/owner/library.js' { const m: typeof import('../src/dashboard/owner/library.ts'); export = m; }
declare module '*/dist/dashboard/owner/workspace-facts.js' { const m: typeof import('../src/dashboard/owner/workspace-facts.ts'); export = m; }
declare module '*/dist/dashboard/token-socket.js' { const m: typeof import('../src/dashboard/token-socket.ts'); export = m; }
