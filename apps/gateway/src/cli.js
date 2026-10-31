#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { alpHome, connectSocket, daemonPaths } from '@anhlp/alp-client';
import { resolveConfig } from './config.js';
import { CredentialStore, createCredential, gatewayHome, listCredentials, reissueCredential, revokeCredential, rotateCredential } from './credentials.js';
import { createGatewayLogger } from './log.js';
import { DEFAULT_PERMISSIONS, PERMISSIONS, TERMINAL_EXEC_WARNING } from './policy.js';
import { createGateway } from './server.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const USAGE = `alp-gateway ${VERSION}: authenticated WebSocket access to this user's alpd (docs/alp/remote-gateway.md)

Usage:
  alp-gateway serve [--config FILE] [--host ADDR] [--port N] [--origin URL]... [--public-host HOST]...
                    [--trust-proxy ADDR]... [--tls-cert FILE --tls-key FILE] [--allow-insecure] [--socket PATH]
  alp-gateway credential create --label TEXT --workspace DIR [--workspace DIR]... [--permission P]...
                                [--mode MODE]... [--agent] [--expires-in-days N] [--json]
  alp-gateway credential list [--json]
  alp-gateway credential rotate ID [--json]
  alp-gateway credential reissue ID [--label TEXT] [--workspace DIR]... [--permission P]...
                                  [--mode MODE]... [--agent] [--expires-in-days N] [--json]
    (alias: edit; named fields replace existing grants, omitted fields stay; issues a new token)
  alp-gateway credential revoke ID

Permissions: ${PERMISSIONS.join(', ')} (default: ${DEFAULT_PERMISSIONS.join(', ')}).
workspace.manage requires explicit --permission and --worktree-mapping ID (host-approved destination).
workspace.write (register pregranted projects and change shared workspace metadata) requires explicit --permission.
files.read (list directories, read text files and, with project.read, Git diffs of the workspaces) is never a default: name it with
--permission for each credential that may read file contents.
attachments.write (upload files into alpd's attachment store and send them in prompts; used with session.write) is never a
default and implies nothing: name it with --permission.
session.team.write (change the team of a live root session; used with session.write) is never a default and implies
nothing: name it with --permission. session.write alone changes a live root's model and effort within --mode.
terminal.exec (open a real shell on the daemon host as the account that runs alpd: every file that account can read
or write, any program, the network) is never a default and implies nothing: name it with --permission. A workspace
only picks where the shell starts; it is NOT a sandbox. alpd also needs its owner's own switch: alp terminal allow.
session.write also forks and rewinds a root's conversation (session.fork needs session.read too); only the
conversation changes, never a file. A token is printed once; only its hash is kept.
--agent makes a credential for an ALP agent: alpd treats every connection it opens as an agent's, whatever the client
says, and refuses it what only you may do (human gates, answers, terminals). It only takes away; a credential stays an
agent credential (reissue --agent adds the mark, nothing removes it). Without --agent a credential is a user's, as before.
Files live in $ALP_GATEWAY_HOME, else $ALP_HOME/gateway. The gateway never starts alpd.`;

const fail = (/** @type {string} */ message) => { console.error(message); process.exit(2); };


async function serve(/** @type {string[]} */ args) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
      origin: { type: 'string', multiple: true }, 'public-host': { type: 'string', multiple: true },
      'trust-proxy': { type: 'string', multiple: true }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
      'allow-insecure': { type: 'boolean' }, socket: { type: 'string' },
    },
  });
  /** @type {import('./config.js').GatewayConfigInput} */
  const file = values.config ? JSON.parse(await readFile(values.config, 'utf8')) : {};
  const input = {
    ...file,
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.origin ? { origins: values.origin } : {}),
    ...(values['public-host'] ? { hosts: values['public-host'] } : {}),
    ...(values['trust-proxy'] ? { trustProxy: values['trust-proxy'] } : {}),
    ...(values['tls-cert'] || values['tls-key'] ? { tls: { cert: values['tls-cert'] ?? '', key: values['tls-key'] ?? '' } } : {}),
    ...(values['allow-insecure'] ? { allowInsecure: true } : {}),
    ...(values.socket ? { socketPath: values.socket } : {}),
  };
  const config = resolveConfig(input);
  const logger = createGatewayLogger();
  const socketPath = config.socketPath ?? daemonPaths(alpHome()).socket;
  const store = new CredentialStore({ home: gatewayHome(), logger });
  const gateway = createGateway({ config, store, logger, version: VERSION, openTransport: () => connectSocket(socketPath) });
  const address = await gateway.listen();
  console.log(JSON.stringify({ listening: address.url, websocket: `${address.url.replace(/^http/, 'ws')}/v1/ws` }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await gateway.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', () => void store.reload());
}

async function credential(/** @type {string[]} */ args) {
  const [action, ...rest] = args;
  const home = gatewayHome();
  if (action === 'create') {
    const { values } = parseArgs({ args: rest, options: { label: { type: 'string' }, workspace: { type: 'string', multiple: true }, permission: { type: 'string', multiple: true }, 'worktree-mapping': { type: 'string', multiple: true }, mode: { type: 'string', multiple: true }, agent: { type: 'boolean' }, 'expires-in-days': { type: 'string' }, json: { type: 'boolean' } } });
    if (!values.label || !values.workspace?.length) fail('credential create needs --label and at least one --workspace');
    const days = values['expires-in-days'] === undefined ? undefined : Number(values['expires-in-days']);
    if (days !== undefined && !(days > 0)) fail('--expires-in-days must be a positive number');
    const permissions = (values.permission ?? [...DEFAULT_PERMISSIONS]).flatMap(entry => entry.split(',')).map(entry => entry.trim()).filter(Boolean);
    const { credential: created, token } = await createCredential(home, {
      label: /** @type {string} */ (values.label), workspaces: /** @type {string[]} */ (values.workspace), permissions, worktreeMappings: values['worktree-mapping'] ?? [],
      ...(values.mode ? { modes: values.mode } : {}),
      ...(values.agent ? { agent: true } : {}),
      ...(days ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
    });
    if (values.json) console.log(JSON.stringify({ credential: created, token }));
    else console.log(`Created credential ${created.id} (${created.label}).\nToken, shown once; keep it in the client's secure storage:\n\n  ${token}\n`);
    if (permissions.includes('terminal.exec')) console.error(TERMINAL_EXEC_WARNING);
    return;
  }
  if (action === 'list') {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
    const list = await listCredentials(home);
    if (values.json) { console.log(JSON.stringify(list)); return; }
    if (!list.length) { console.log('No credentials.'); return; }
    for (const entry of list) {
      const state = entry.revokedAt ? `revoked ${entry.revokedAt}` : entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now() ? `expired ${entry.expiresAt}` : 'active';
      console.log(`${entry.id}  ${entry.label}  ${state}  ${entry.permissions.join(',')}  ${entry.workspaces.map(workspace => workspace.path).join(', ')}${entry.modes ? `  modes ${entry.modes.join(',')}` : ''}${entry.agent ? '  agent' : ''}`);
    }
    return;
  }
  if (action === 'reissue' || action === 'edit') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { label: { type: 'string' }, workspace: { type: 'string', multiple: true }, permission: { type: 'string', multiple: true }, 'worktree-mapping': { type: 'string', multiple: true }, mode: { type: 'string', multiple: true }, agent: { type: 'boolean' }, 'expires-in-days': { type: 'string' }, json: { type: 'boolean' } } });
    if (positionals.length !== 1) fail(`credential ${action} needs one credential id`);
    const days = values['expires-in-days'] === undefined ? undefined : Number(values['expires-in-days']);
    if (days !== undefined && (!Number.isFinite(days) || !(days > 0))) fail('--expires-in-days must be a positive finite number');
    const { credential: issued, token } = await reissueCredential(home, positionals[0], {
      ...(values.label !== undefined ? { label: values.label } : {}),
      ...(values['worktree-mapping'] !== undefined ? { worktreeMappings: values['worktree-mapping'] } : {}),
      ...(values.workspace !== undefined ? { workspaces: values.workspace } : {}),
      ...(values.permission !== undefined ? { permissions: values.permission.flatMap(entry => entry.split(',')).map(entry => entry.trim()).filter(Boolean) } : {}),
      ...(values.mode !== undefined ? { modes: values.mode } : {}),
      ...(values.agent ? { agent: true } : {}),
      ...(days !== undefined ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
    });
    if (values.json) console.log(JSON.stringify({ credential: issued, token }));
    else console.log(`Reissued ${issued.id}; the old token no longer works and its connections close after the gateway reloads.\nNew token, shown once:\n\n  ${token}\n`);
    if (issued.permissions?.includes('terminal.exec')) console.error(TERMINAL_EXEC_WARNING);
    return;
  }
  if (action === 'rotate') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
    if (positionals.length !== 1) fail('credential rotate needs one credential id');
    const { credential: rotated, token } = await rotateCredential(home, positionals[0]);
    if (values.json) console.log(JSON.stringify({ credential: rotated, token }));
    else console.log(`Rotated ${rotated.id}; the old token no longer works and its connections close.\nNew token, shown once:\n\n  ${token}\n`);
    return;
  }
  if (action === 'revoke') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    if (positionals.length !== 1) fail('credential revoke needs one credential id');
    const revoked = await revokeCredential(home, positionals[0]);
    console.log(`Revoked ${revoked.id}; a running gateway closes its connections within a few seconds.`);
    return;
  }
  fail(USAGE);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'serve') await serve(args);
  else if (command === 'credential') await credential(args);
  else if (command === '--version') console.log(VERSION);
  else { console.log(USAGE); if (command !== '--help' && command !== 'help') process.exitCode = 2; }
} catch (error) {
  fail(`alp-gateway: ${error instanceof Error ? error.message : String(error)}`);
}
