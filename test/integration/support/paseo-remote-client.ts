#!/usr/bin/env node
// The Paseo side of the remote mode as a process of its own (docs/alp/paseo-remote.md §6): the
// built remote entry (integrations/paseo/server/dist/remote/index.js), configured like the plugin
// is (ALP_GATEWAY_URL, ALP_GATEWAY_TOKEN), behind a stand-in for Paseo's plugin host. The test runs
// it under Node's permission model with read access to the code only and no child processes, so
// it cannot touch alpd's ALP_HOME or the project, and cannot start anything; `probe` proves it.
// Commands arrive as JSON lines on stdin; answers and provider events leave as JSON lines.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

/** What the test reads of Paseo's provider connection and the panels' contracts. */
type Connection = { capabilities: unknown, onEvent(listener: (event: unknown) => void): void, send(input: unknown): Promise<unknown>, close(): Promise<unknown> };
type Provider = { connect(options: { versions: number[], capabilities: unknown }): Promise<Connection> };
type Schema = { parse(value: unknown): unknown };
type Contract = { name: string, input: Schema, output: Schema };
type Handler = (input: unknown) => unknown;
type Failure = { message?: unknown, code?: unknown, data?: unknown };

// The test always sets ALP_REMOTE_ENTRY; without it the import fails, as before.
const entry = process.env.ALP_REMOTE_ENTRY as string;
const remote = await import(entry);
const { PROVIDER_CAPABILITIES } = await import('@getpaseo/plugin/server/provider');
const out = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

// What Paseo's plugin host gives contribute(): a provider registry and the panels' RPC handlers.
const handlers = new Map<string, { contract: Contract, handler: Handler }>();
let registration: Provider | undefined;
const server = {
  registerProvider(provider: Provider) { registration = provider; },
  handle(contract: Contract, handler: Handler) { handlers.set(contract.name, { contract, handler }); },
};
const dispose = remote.contributeRemote(server, remote.gatewayConfig(), 'e2e');
let connection: Connection | undefined;

// The commands read their arguments from the test's JSON lines as they are, unchecked.
const commands: Record<string, (args: any) => Promise<unknown>> = {
  async connect() {
    // connect follows the contribution, which registered the provider (as before, a missing one throws).
    connection = await registration!.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
    connection.onEvent((event: unknown) => out({ event }));
    return { capabilities: connection.capabilities };
  },
  // send follows connect (as before, sending first throws).
  async send({ input }: { input: unknown }) { await connection!.send(input); return {}; },
  async panel({ name, input }: { name: string, input: unknown }) {
    const found = handlers.get(name);
    if (!found) throw new Error(`no handler ${name}`);
    return found.contract.output.parse(await found.handler(found.contract.input.parse(input)));
  },
  /** What this process may not do: read alpd's home or the project, or start a process. */
  async probe({ paths }: { paths: string[] }) {
    const reads: Record<string, string> = {};
    for (const file of paths) reads[file] = await readFile(file, 'utf8').then(() => 'read', (error: NodeJS.ErrnoException) => error.code ?? 'error');
    let spawn: string;
    try { const result = spawnSync('/bin/echo', ['x']); spawn = result.error ? ((result.error as NodeJS.ErrnoException).code ?? 'error') : 'spawned'; } catch (error) { spawn = (error as NodeJS.ErrnoException).code ?? 'error'; }
    return { reads, spawn, home: process.env.ALP_HOME };
  },
  async close() { await connection?.close(); dispose(); setTimeout(() => process.exit(0), 50); return {}; },
};

for await (const line of createInterface({ input: process.stdin })) {
  const { id, op, ...rest } = JSON.parse(line);
  Promise.resolve().then(() => commands[op](rest)).then(
    result => out({ id, ok: true, result }),
    (error: Failure | undefined) => out({ id, ok: false, error: { message: String(error?.message ?? error), code: error?.code, data: error?.data } }),
  );
}
