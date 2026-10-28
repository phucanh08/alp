import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { alpHome, connect, daemonPaths, discoverIntegration, startIntegration } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { built, start, running } from './daemon.js';
import { DAEMON_ENTRY, distributionEntry } from './paths.js';
import { alpWebEntry, isWebClaimed, isWebReady, refusal, stopPreRenamePaseo, stopWebService, webOwner } from './web-service.js';

/** The Paseo integration (its web app, bridge and relay) runs as integration `paseo`. */
const PASEO = 'paseo';
/** alp-web (packages/cli/src/web), the service behind `alp web`, runs as integration `web`. */
const WEB = 'web';

/**
 * Starts the Paseo integration. For one release, a home that still has only the descriptor
 * registered before the rename (`integrations/web.json`) keeps working, with a hint to re-register.
 * Exported for tests.
 * @param {string} home
 */
export async function startPaseoIntegration(home) {
  const entry = await discoverIntegration(PASEO, { home });
  if (!entry) {
    const legacy = path.join(home, 'integrations', 'web.json');
    const legacyEntry = await legacyDescriptorEntry(legacy, home);
    if (legacyEntry) {
      console.error(`Using the Paseo integration registered before its rename (${legacy}); run \`alp-paseo-integration --register\` to register it again.`);
      return startIntegration({ name: PASEO, entry: legacyEntry, home });
    }
  }
  return startIntegration({ name: PASEO, home });
}

/**
 * The entry named by the pre-rename descriptor `<home>/integrations/web.json`, and nothing else: no
 * environment, distribution or PATH lookup, since the name `web` now belongs to alp-web. A relative
 * `main` resolves against the descriptor's directory, then the home, as discovery does.
 * @param {string} file
 * @param {string} home
 */
async function legacyDescriptorEntry(file, home) {
  // A missing or corrupt descriptor is no registration: the caller then reports the missing package.
  const raw = await readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
  const isFile = candidate => stat(candidate).then(info => info.isFile(), () => false);
  // The fields discovery accepts in a descriptor, in its priority order.
  for (const field of ['main', 'entry', 'path', 'command']) {
    const value = raw?.[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const candidates = path.isAbsolute(value) ? [value] : [path.resolve(path.dirname(file), value), path.resolve(home, value)];
    for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Whether the current working directory is an ALP project: its grant then covers it. */
async function currentProject() {
  const cwd = process.cwd();
  return await stat(path.join(cwd, '.alp')).then(info => info.isDirectory(), () => false) ? cwd : undefined;
}

/** `--project <cwd>` when the directory `alp web` runs in is an ALP project: its grant then covers it. */
async function projectArgs() {
  const project = await currentProject();
  return project ? ['--project', project] : [];
}

/**
 * Registers `directory` as a project in alpd via IPC (`project.register`).
 * If alpd cannot be reached or the call fails, this is best-effort.
 * @param {string} home
 * @param {string} directory
 */
async function registerProject(home, directory) {
  const socket = daemonPaths(home).socket;
  let client;
  try { client = await connect(socket, { name: 'alp-cli', version: '1' }); }
  catch { return; }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const list = await client.request('project.list', { limit: 1 }).catch(() => undefined);
      const revision = typeof list?.revision === 'number' ? list.revision : 0;
      try {
        await client.request('project.register', { directory, ifRevision: revision, requestId: randomUUID() });
        break;
      } catch (error) {
        if (error?.data?.reason === 'stale_revision' && attempt < 4) continue;
        break;
      }
    }
  } catch {}
  finally {
    try { client.close(); } catch {}
  }
}

/**
 * Waits until the credential in `<home>/web/credentials.json` contains `project`.
 * Polls for up to `timeoutMs` (default 5,000 ms).
 * @param {string} home
 * @param {string} credentialId
 * @param {string} project
 * @param {{ timeoutMs?: number }} [options]
 */
async function waitForGrant(home, credentialId, project, { timeoutMs = 5_000 } = {}) {
  const credentialsFile = path.join(home, 'web', 'credentials.json');
  const canonical = await realpath(project).catch(() => project);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await readFile(credentialsFile, 'utf8'));
      const credential = raw?.credentials?.find(c => c.id === credentialId && !c.revokedAt);
      if (credential?.workspaces?.some(w => w.canonical === canonical || w.path === project || w.path === canonical)) {
        return true;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/** Whether settings.json turns alp web off. @param {string} home */
async function webDisabled(home) {
  const settings = await readFile(path.join(home, 'settings.json'), 'utf8').then(text => JSON.parse(text), () => undefined);
  return settings?.web?.enabled === false;
}

const DISABLED = 'alp web is disabled by settings ("web.enabled": false).';

/**
 * Starts alp-web unless it runs and returns the address to open, the token in its fragment (which
 * the browser never sends to a server). The Paseo integration from before its rename, still running
 * as integration `web`, is stopped first.
 * @param {string} home @param {string} entry
 */
async function serveWeb(home, entry) {
  await stopPreRenamePaseo(home);
  // A lock held by a process proven not to be alp web: say so now rather than wait for it. A
  // running alp-web (its web.json names the lock's pid and is answering) is left to startIntegration.
  const held = await webOwner(home);
  const published = await readFile(path.join(home, 'web.json'), 'utf8').then(text => JSON.parse(text), () => undefined);
  const lockPid = await readFile(path.join(home, 'integrations', 'web.lock'), 'utf8').then(text => JSON.parse(text)?.pid, () => undefined);
  const claimed = await isWebClaimed(published, lockPid, held);
  if ('reason' in held && held.alive && held.kind === 'foreign' && !claimed) throw new Error(`${refusal(home)} (${held.reason}). Stop it, then run alp web again.`);
  const project = await currentProject();
  let lock;
  try { lock = await startIntegration({ name: WEB, entry, home, args: project ? ['--project', project] : [] }); }
  catch (error) {
    // Still held by a live process alp cannot prove: name it, as the wait may have been for it.
    const owner = await webOwner(home);
    if ('reason' in owner && owner.alive) throw new Error(`${error?.message ?? error}\n${refusal(home)} (${owner.reason}). If it is not alp web, stop it, then run alp web again.`, { cause: error });
    throw error;
  }
  const info = await readFile(path.join(home, 'web.json'), 'utf8').then(text => JSON.parse(text), () => undefined);
  if (info?.app !== 'alp-web' || info.pid !== lock.pid) {
    const owner = await webOwner(home);
    throw new Error(`${refusal(home)}${'reason' in owner ? ` (${owner.reason})` : ''}. Stop pid ${lock.pid}, then run alp web again.`);
  }
  if (typeof info.url !== 'string' || typeof info.token !== 'string' || !(await isWebReady(info.url))) {
    throw new Error(`alp web published no address; see ${path.join(home, 'logs', 'integrations', 'alp-web.log')}`);
  }
  if (project) {
    await registerProject(home, project);
    await waitForGrant(home, info.credentialId, project);
  }
  return `${info.url}#token=${info.token}`;
}

async function webCommand(args) {
  if (args[0] === 'pair') return pairCommand(args.slice(1));
  if (args[0] === 'rotate') return rotateCommand(args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { print: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const entry = alpWebEntry();
  const home = alpHome();
  if (await webDisabled(home)) throw new Error(DISABLED);
  await start();
  const url = await serveWeb(home, entry);
  console.log(url);
  if (values.print) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => console.error('Open the address above in your browser')).unref();
}

/**
 * alp web rotate: alp web's token is replaced and the old one revoked, so every open page loses
 * access. Only the process holding the web lock writes alp web's credentials, so the service is
 * stopped first; `alp-web.js --rotate` then takes the lock, replaces the credential, records the
 * new token in web.json and releases the lock, and the service starts again with it.
 */
async function rotateCommand(args) {
  if (args.length) throw new UsageError();
  const entry = alpWebEntry();
  const home = alpHome();
  await start();
  const project = await projectArgs();
  for (let attempt = 1; ; attempt++) {
    await stopWebService(home);
    const rotated = await new Promise(resolve => {
      execFile(process.execPath, [entry, '--rotate', ...project], { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGTERM' },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stderr}${stdout}`.trim() }));
    });
    if (rotated.code === 0) break;
    // Exit 3: alp web started again between the stop and the rotation; stop it once more.
    if (rotated.code !== 3 || attempt >= 3) throw new Error(`alp web could not rotate its token${rotated.output ? `:\n${rotated.output.slice(-2000)}` : ''}`);
  }
  if (await webDisabled(home)) {
    console.log(`alp web has a new token; the old one no longer works. ${DISABLED.replace(/\.$/, '')}, so it was not started.`);
    return;
  }
  console.log(await serveWeb(home, entry));
}

/**
 * alp web pair: the link that pairs Paseo's app on another device with alpd through Paseo's relay
 * (ALPD §64). The device then signs in with the password this command prints (the token kept in
 * ~/.alp/paseo.json).
 */

/**
 * `web.pairing` is an extension the integration registers on its alpd connection. Right after an
 * alpd restart the old registration is gone and the new one may still be in flight, so an
 * unknown-method reply means "not yet", not "never": wait for the fresh registration.
 *
 * Exported so the wait can be pinned by a regression test without a live daemon restart.
 */
export async function requestPairing(client, params, attempts = 50) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await client.request('web.pairing', params).then(value => ({ value }), error => ({ error }));
    if (!outcome.error) return outcome.value;
    last = outcome.error;
    const unknown = outcome.error?.code === -32601 || /unknown method|not available|not registered/i.test(outcome.error?.message ?? '');
    if (!unknown) throw outcome.error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last ?? new Error('alpd did not register web.pairing; run `alp web` to let the integration start, then retry');
}

async function pairCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: 'boolean' }, off: { type: 'boolean' } } });
  if (positionals.length || (values.on && values.off)) throw new UsageError();
  await start();
  const home = alpHome();
  await startPaseoIntegration(home);
  const client = await running();
  try {
    const pairing = await requestPairing(client, values.on ? { enable: true } : values.off ? { enable: false } : {});
    if (!pairing.relayEnabled) {
      console.log(`The relay is off${values.off ? ' now' : ''}. Turn it on with: alp web pair --on`);
      return;
    }
    console.log(`Relay ${pairing.endpoint}: ${pairing.connected ? 'connected' : 'connecting'}`);
    console.log(`Open this link on the device that runs Paseo's app:\n${pairing.url}`);
    const password = await readFile(path.join(home, `${PASEO}.json`), 'utf8').then(text => JSON.parse(text)?.token).catch(() => undefined);
    if (typeof password === 'string' && password) console.log(`When Paseo's app asks for a password, give it: ${password}`);
    else console.log(`When Paseo's app asks for a password, give it the token in ${path.join(home, `${PASEO}.json`)}.`);
  } finally {
    client.close();
  }
}

/** alp acp: ALP as an ACP agent for editors; stdout carries only the protocol (ALPD §60). */

async function acpCommand(args) {
  if (args.length) throw new UsageError();
  await built();
  const { runAcp } = await import(distributionEntry('acp.js'));
  await runAcp({ daemonEntry: DAEMON_ENTRY });
}

export { webCommand, pairCommand, acpCommand };
