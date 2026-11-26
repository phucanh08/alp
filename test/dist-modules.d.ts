// Types for the build output the tests import (../../dist/..., ../../packages/*/dist/..., ...).
// `pnpm run check` type-checks test/ before anything is built, and the root dist/ bundles never have a
// .d.ts, so each module the tests import is declared here with the type of the source it is built from.
// The import paths in the tests stay as they are: at run time they load the build output. A pattern
// matches a relative specifier by its end; once a package's own dist/*.d.ts exists, TypeScript uses that
// file instead (the same types, emitted from the same source), and a built .js without one still takes
// the declaration here. `export = m` gives the source's named exports; a module whose default export a
// test imports lists its members instead (see the Paseo server).

//
// One entry per module, in path order. Add an entry here rather than a second file: two declarations
// of the same pattern conflict.

// The Paseo server's virtual modules (alp:templates, alp:plugin-client) are declared beside its sources.
/// <reference path="../integrations/paseo/server/alp-templates.d.ts" />

declare module '*/apps/gateway/dist/index.js' { const m: typeof import('../apps/gateway/src/index.ts'); export = m; }

// Written by hand, unlike the others: apps/web/src/lib is browser code that needs the DOM lib, and
// adding DOM to test/ breaks the Node-typed sources the tests also read (ReadableStream in
// packages/cli self-update.ts). Only the members the tests use, with the types of
// apps/web/src/lib/controller.ts (Controller, State) as far as the tests read them.
declare module '*/apps/web/dist-lib/controller.js' {
  type Tree = { status: string, rootId: string, projection: { entries: Array<{ sessionId: string }> } };
  /** The parts of the controller's State the tests read. */
  type State = {
    connection: { phase: string },
    sessions: { status: string },
    tree: Tree | null,
    busy: Record<string, boolean>,
  };
  /** ControllerOptions: `open` and `reconnecting` take and return the gateway's link objects. */
  type ControllerOptions = {
    // `any`: the link and client objects the test fakes are typed in the browser sources this file cannot load.
    open?: (options?: { signal?: AbortSignal }) => Promise<any>,
    reconnecting?: (options: any) => any,
    stableMs?: number,
    backoff?: { initialMs?: number, maxMs?: number, jitter?: number },
    sessionPollMs?: number,
    taskPollMs?: number,
  };
  export class Controller {
    constructor(options?: ControllerOptions);
    getState(): State;
    connect(target: { url: string, token: string, link?: boolean }): void;
    disconnect(options?: { keepTerminals?: boolean, keepLink?: boolean }): void;
    selectWorkspace(workspace: string | null): void;
    selectSession(root: string | null): void;
    sendPrompt(text: string, root?: string | null): Promise<unknown>;
    interrupt(): Promise<unknown>;
  }
}

declare module '*/dist/acp/agent.js' { const m: typeof import('../packages/cli/src/acp/agent.ts'); export = m; }
declare module '*/dist/runtime/index.js' { const m: typeof import('../packages/runtime/src/index.ts'); export = m; }
// Listed by member: it has a default export, which `export = m` would not carry to a default import.
declare module '*/integrations/paseo/server/dist/index.js' {
  type Server = typeof import('../integrations/paseo/server/index.ts');
  export const createProvider: Server['createProvider'];
  export const createPaseoBridge: Server['createPaseoBridge'];
  const contribute: Server['default'];
  export default contribute;
}

declare module '*/packages/cli/dist/commands/session/output.js' { const m: typeof import('../packages/cli/src/commands/session/output.ts'); export = m; }
declare module '*/packages/cli/dist/commands/update/self-update.js' { const m: typeof import('../packages/cli/src/commands/update/self-update.ts'); export = m; }
declare module '*/packages/cli/dist/dashboard/owner/library.js' { const m: typeof import('../packages/cli/src/dashboard/owner/library.ts'); export = m; }
declare module '*/packages/client/dist/connection/websocket.js' { const m: typeof import('../packages/client/src/connection/websocket.ts'); export = m; }
declare module '*/packages/client/dist/index.js' { const m: typeof import('../packages/client/src/index.ts'); export = m; }
declare module '*/packages/client/dist/mcp-probe.js' { const m: typeof import('../packages/client/src/mcp-probe.ts'); export = m; }
declare module '*/packages/client/dist/portable.js' { const m: typeof import('../packages/client/src/portable.ts'); export = m; }
declare module '*/packages/client/dist/render.js' { const m: typeof import('../packages/client/src/render.ts'); export = m; }
declare module '*/packages/client/dist/service.js' { const m: typeof import('../packages/client/src/service.ts'); export = m; }
declare module '*/dist/daemon/index.js' { const m: typeof import('../packages/daemon/src/index.ts'); export = m; }
declare module '*/integrations/paseo/server/dist/web.js' { const m: typeof import('../integrations/paseo/server/web.ts'); export = m; }
declare module '*/packages/cli/dist/commands/dashboard/paseo.js' { const m: typeof import('../packages/cli/src/commands/dashboard/paseo.ts'); export = m; }
declare module '*/packages/client/dist/acp-probe.js' { const m: typeof import('../packages/client/src/acp-probe.ts'); export = m; }
declare module '*/packages/client/dist/antigravity-probe.js' { const m: typeof import('../packages/client/src/antigravity-probe.ts'); export = m; }
declare module '*/packages/client/dist/doctor.js' { const m: typeof import('../packages/client/src/doctor.ts'); export = m; }
declare module '*/packages/client/dist/library-test.js' { const m: typeof import('../packages/client/src/library-test.ts'); export = m; }

// Written by hand: the feature-architecture skill's checker is a JavaScript template copied into user
// projects, with no TypeScript source to point at. These are the three exports architecture-contract.test.ts
// calls, as the script's own JSDoc and return statements describe them.
declare module '*/feature-architecture/scripts/check-boundaries.mjs' {
  type Violation = { file: string, line: number, from: string, to: string, specifier: string, target: string, rule: string };
  export function globRegExp(glob: string): RegExp;
  export function importsOf(text: string): Array<{ specifier: string, line: number }>;
  export function checkBoundaries(root: string, contractValue: unknown, options?: { today?: Date }): Promise<{ files: number, violations: Violation[], excepted: object[], unusedExceptions: object[] }>;
}
