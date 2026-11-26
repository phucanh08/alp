// Types for the build output these tests import that has no declaration file: the plugin's server/dist ships no declarations (#111,
// scripts/build-paseo.ts).
// Unbuilt, tsconfig.json's rootDirs already types `../server/dist/x.js` against the source x.ts; once built, that
// .js without a .d.ts would win and type as nothing, so `pnpm run check` would depend on whether a build
// ran. Each module is declared here with the type of the source it is built from (as test/dist-modules.d.ts
// does for the root tests). One entry per module the tests import, in path order.
declare module '*/server/dist/index.js' { const m: typeof import('../server/index.ts'); export = m; }
declare module '*/server/dist/main.js' { const m: typeof import('../server/main.ts'); export = m; }
declare module '*/server/dist/pairing-guard.js' { const m: typeof import('../server/pairing-guard.ts'); export = m; }
declare module '*/server/dist/paseo/agents.js' { const m: typeof import('../server/paseo/agents.ts'); export = m; }
declare module '*/server/dist/paseo/create-receipts.js' { const m: typeof import('../server/paseo/create-receipts.ts'); export = m; }
declare module '*/server/dist/paseo/files.js' { const m: typeof import('../server/paseo/files.ts'); export = m; }
declare module '*/server/dist/paseo/gateway.js' { const m: typeof import('../server/paseo/gateway.ts'); export = m; }
declare module '*/server/dist/paseo/git.js' { const m: typeof import('../server/paseo/git.ts'); export = m; }
declare module '*/server/dist/paseo/index.js' { const m: typeof import('../server/paseo/index.ts'); export = m; }
declare module '*/server/dist/paseo/uploads.js' { const m: typeof import('../server/paseo/uploads.ts'); export = m; }
declare module '*/server/dist/paseo/workspaces.js' { const m: typeof import('../server/paseo/workspaces.ts'); export = m; }
declare module '*/server/dist/provider-core.js' { const m: typeof import('../server/provider-core.ts'); export = m; }
declare module '*/server/dist/provider.js' { const m: typeof import('../server/provider.ts'); export = m; }
declare module '*/server/dist/shutdown.js' { const m: typeof import('../server/shutdown.ts'); export = m; }
declare module '*/server/dist/uploads.js' { const m: typeof import('../server/uploads.ts'); export = m; }
declare module '*/server/dist/web.js' { const m: typeof import('../server/web.ts'); export = m; }
