// Types for the build output these tests import that has no declaration file: src/lib built into
// ../dist-lib by scripts/build-lib.ts (esbuild, no declarations).
// Unbuilt, tsconfig.json's rootDirs already types `../dist-lib/x.js` against the source src/lib/x.ts; once
// built, that .js without a .d.ts would win and type as nothing, so `pnpm run check` would depend on
// whether a build ran. Each module is declared here with the type of the source it is built from (as
// packages/cli/tests/dist-modules.d.ts does). One entry per module the tests import, in path order. Each
// re-exports its source through tsconfig.json's @alp-web-lib/* path (types included, unlike `typeof
// import`), as an ambient module cannot re-export a relative one.
declare module '*/dist-lib/attachments.js' { export * from '@alp-web-lib/attachments.ts'; }
declare module '*/dist-lib/attention.js' { export * from '@alp-web-lib/attention.ts'; }
declare module '*/dist-lib/browser-url.js' { export * from '@alp-web-lib/browser-url.ts'; }
declare module '*/dist-lib/chat-display.js' { export * from '@alp-web-lib/chat-display.ts'; }
declare module '*/dist-lib/code-fence.js' { export * from '@alp-web-lib/code-fence.ts'; }
declare module '*/dist-lib/command-center.js' { export * from '@alp-web-lib/command-center.ts'; }
declare module '*/dist-lib/configure.js' { export * from '@alp-web-lib/configure.ts'; }
declare module '*/dist-lib/controller.js' { export * from '@alp-web-lib/controller.ts'; }
declare module '*/dist-lib/conversation.js' { export * from '@alp-web-lib/conversation.ts'; }
declare module '*/dist-lib/diagnostics.js' { export * from '@alp-web-lib/diagnostics.ts'; }
declare module '*/dist-lib/errors.js' { export * from '@alp-web-lib/errors.ts'; }
declare module '*/dist-lib/file-icons.js' { export * from '@alp-web-lib/file-icons.ts'; }
declare module '*/dist-lib/file-links.js' { export * from '@alp-web-lib/file-links.ts'; }
declare module '*/dist-lib/file-search.js' { export * from '@alp-web-lib/file-search.ts'; }
declare module '*/dist-lib/file-tree.js' { export * from '@alp-web-lib/file-tree.ts'; }
declare module '*/dist-lib/files-panel-state.js' { export * from '@alp-web-lib/files-panel-state.ts'; }
declare module '*/dist-lib/gateway.js' { export * from '@alp-web-lib/gateway.ts'; }
declare module '*/dist-lib/git.js' { export * from '@alp-web-lib/git.ts'; }
declare module '*/dist-lib/history.js' { export * from '@alp-web-lib/history.ts'; }
declare module '*/dist-lib/inline-markdown.js' { export * from '@alp-web-lib/inline-markdown.ts'; }
declare module '*/dist-lib/layout.js' { export * from '@alp-web-lib/layout.ts'; }
declare module '*/dist-lib/library.js' { export * from '@alp-web-lib/library.ts'; }
declare module '*/dist-lib/link-token.js' { export * from '@alp-web-lib/link-token.ts'; }
declare module '*/dist-lib/mentions.js' { export * from '@alp-web-lib/mentions.ts'; }
declare module '*/dist-lib/new-session.js' { export * from '@alp-web-lib/new-session.ts'; }
declare module '*/dist-lib/owner-host.js' { export * from '@alp-web-lib/owner-host.ts'; }
declare module '*/dist-lib/owner-library.js' { export * from '@alp-web-lib/owner-library.ts'; }
declare module '*/dist-lib/pane-find.js' { export * from '@alp-web-lib/pane-find.ts'; }
declare module '*/dist-lib/panes.js' { export * from '@alp-web-lib/panes.ts'; }
declare module '*/dist-lib/preferences.js' { export * from '@alp-web-lib/preferences.ts'; }
declare module '*/dist-lib/shortcuts.js' { export * from '@alp-web-lib/shortcuts.ts'; }
declare module '*/dist-lib/sidebar-facts.js' { export * from '@alp-web-lib/sidebar-facts.ts'; }
declare module '*/dist-lib/sidebar-model.js' { export * from '@alp-web-lib/sidebar-model.ts'; }
declare module '*/dist-lib/slash-commands.js' { export * from '@alp-web-lib/slash-commands.ts'; }
declare module '*/dist-lib/tab-close.js' { export * from '@alp-web-lib/tab-close.ts'; }
declare module '*/dist-lib/task-board.js' { export * from '@alp-web-lib/task-board.ts'; }
declare module '*/dist-lib/terminal.js' { export * from '@alp-web-lib/terminal.ts'; }
declare module '*/dist-lib/terminal-links.js' { export * from '@alp-web-lib/terminal-links.ts'; }
declare module '*/dist-lib/theme-previews.js' { export * from '@alp-web-lib/theme-previews.ts'; }
declare module '*/dist-lib/timeline.js' { export * from '@alp-web-lib/timeline.ts'; }
declare module '*/dist-lib/tool-calls.js' { export * from '@alp-web-lib/tool-calls.ts'; }
declare module '*/dist-lib/tracks.js' { export * from '@alp-web-lib/tracks.ts'; }
declare module '*/dist-lib/usage.js' { export * from '@alp-web-lib/usage.ts'; }
declare module '*/dist-lib/usage-prefs.js' { export * from '@alp-web-lib/usage-prefs.ts'; }
declare module '*/dist-lib/window-controls.js' { export * from '@alp-web-lib/window-controls.ts'; }
