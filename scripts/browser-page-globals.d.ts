// Types only (never loaded at run time): the page globals that client-sdk-smoke.ts reads inside
// Playwright's page.evaluate()/waitForFunction() callbacks. Those callbacks run in the browser page,
// where PAGE_ENTRY defines `window.sdk`; the scripts' tsconfig has no DOM lib, so `window` is declared
// here with only what the smoke uses.

// What the never-answered request ended as: the rejection's fields, or the string 'resolved' (a
// string's .reason/.code read as undefined, which is what the smoke checks for).
type SmokeNeverOutcome = { reason?: string, code?: number, closeReason?: string };

interface SmokeSdk {
  open(url: string): Promise<number>;
  request(method: string, params?: unknown): Promise<any>; // any: each RPC method answers its own result shape
  types(sessionId: string): string[];
  accepted(id: string): boolean;
  abortedPrompt(params: unknown): Promise<string>;
  startNever(): boolean;
  never(): Promise<SmokeNeverOutcome> | undefined;
  closed(): boolean;
  hasNode(): { process: string, Buffer: string };
}

declare var window: { sdk: SmokeSdk, never?: Promise<SmokeNeverOutcome> };
