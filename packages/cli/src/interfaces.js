import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { alpHome, discoverIntegration, lockAlive, readLock, startIntegration } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { built, start, running } from './daemon.js';
import { DAEMON_ENTRY, distributionEntry } from './paths.js';

/** The Paseo integration (its web app, bridge and relay) runs as integration `paseo`. */
const PASEO = 'paseo';

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
  const main = await readFile(file, 'utf8').then(text => JSON.parse(text)?.main, () => undefined);
  if (typeof main !== 'string' || !main) return undefined;
  const isFile = candidate => stat(candidate).then(info => info.isFile(), () => false);
  const candidates = path.isAbsolute(main) ? [main] : [path.resolve(path.dirname(file), main), path.resolve(home, main)];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

async function webCommand(args) {
  if (args[0] === 'pair') return pairCommand(args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { print: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const lock = await readLock(alpHome()).catch(() => undefined);
  await start();
  try {
    const settings = JSON.parse(await readFile(path.join(alpHome(),'settings.json'),'utf8'));
    if (settings?.web?.enabled === false) throw new Error('ALP web app is disabled by settings ("web.enabled": false).');
  } catch (error) { if (/disabled by settings/.test(error?.message ?? '')) throw error; }
  // The web app is owned by the optional Paseo integration.
  const home = alpHome();
  await startPaseoIntegration(home);
  const file = path.join(home, `${PASEO}.json`);
  let info;
  // A fresh integration writes paseo.json just before it is ready; stale files from daemon or an older pid are rejected.
  for (let i = 0; i < 100; i++) {
    info = await readFile(file, 'utf8').then(JSON.parse, () => undefined);
    let alive = false;
    try { if (info?.pid) { process.kill(info.pid, 0); alive = true; } } catch { alive = false; }
    let integrationPid = undefined;
    try { integrationPid = JSON.parse(await readFile(path.join(home, 'integrations', `${PASEO}.lock`), 'utf8'))?.pid; } catch {}
    if (info?.token && info?.url && alive && info.pid !== lock?.pid && (!integrationPid || info.pid === integrationPid)) break;
    info = undefined;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!info) throw new Error(lockAlive(lock) ? 'alpd serves no web app: it is older than this alp (alp daemon restart), or "web": { "enabled": false } is set in ~/.alp/settings.json' : 'alpd started without its web app; see ~/.alp/logs/alpd.log');
  // The token rides in the fragment, which the browser never sends to a server.
  const url = `${info.url}#token=${info.token}`;
  console.log(url);
  if (values.print) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => console.error('Open the address above in your browser')).unref();
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
    console.log(`Open this link on the device, or scan the QR code in the web app (Settings → host → Pair device):\n${pairing.url}`);
    const password = await readFile(path.join(home, `${PASEO}.json`), 'utf8').then(text => JSON.parse(text)?.token, () => undefined);
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
