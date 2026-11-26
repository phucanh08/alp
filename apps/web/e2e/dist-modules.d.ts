// Types for the build output these specs import that has no declaration file: src/lib built into
// ../dist-lib by scripts/build-lib.ts (esbuild, no declarations). As in ../tests/dist-modules.d.ts:
// unbuilt, rootDirs types the import against src/lib; built, the bare .js would win and type as
// nothing, so each module the specs import is declared with its source, through tsconfig.json's
// @anhlp/alp-web/src/lib/* path (this package's own name).
declare module '*/dist-lib/gateway.js' { export * from '@anhlp/alp-web/src/lib/gateway.ts'; }
