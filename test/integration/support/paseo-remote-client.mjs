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

const entry = process.env.ALP_REMOTE_ENTRY;
const remote = await import(entry);
const { PROVIDER_CAPABILITIES } = await import('@getpaseo/plugin/server/provider');
const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);

// What Paseo's plugin host gives contribute(): a provider registry and the panels' RPC handlers.
const handlers = new Map();
let registration;
const server = {
  registerProvider(provider) { registration = provider; },
  handle(contract, handler) { handlers.set(contract.name, { contract, handler }); },
};
const dispose = remote.contributeRemote(server, remote.gatewayConfig(), 'e2e');
let connection;

const commands = {
  async connect() {
    connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
    connection.onEvent(event => out({ event }));
    return { capabilities: connection.capabilities };
  },
  async send({ input }) { await connection.send(input); return {}; },
  async panel({ name, input }) {
    const found = handlers.get(name);
    if (!found) throw new Error(`no handler ${name}`);
    return found.contract.output.parse(await found.handler(found.contract.input.parse(input)));
  },
  /** What this process may not do: read alpd's home or the project, or start a process. */
  async probe({ paths }) {
    const reads = {};
    for (const file of paths) reads[file] = await readFile(file, 'utf8').then(() => 'read', error => error.code ?? 'error');
    let spawn;
    try { const result = spawnSync('/bin/echo', ['x']); spawn = result.error ? (result.error.code ?? 'error') : 'spawned'; } catch (error) { spawn = error.code ?? 'error'; }
    return { reads, spawn, home: process.env.ALP_HOME };
  },
  async close() { await connection?.close(); dispose(); setTimeout(() => process.exit(0), 50); return {}; },
};

for await (const line of createInterface({ input: process.stdin })) {
  const { id, op, ...rest } = JSON.parse(line);
  Promise.resolve().then(() => commands[op](rest)).then(
    result => out({ id, ok: true, result }),
    error => out({ id, ok: false, error: { message: String(error?.message ?? error), code: error?.code, data: error?.data } }),
  );
}
