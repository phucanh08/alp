import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { alpHome, lockAlive, readLock } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { built, start, running } from './daemon.js';
import { DAEMON_ENTRY, distributionEntry } from './paths.js';

async function webCommand(args) {
  if (args[0] === 'pair') return pairCommand(args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { print: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const lock = await readLock(alpHome()).catch(() => undefined);
  await start();
  const file = path.join(alpHome(), 'web.json');
  let info;
  // A fresh alpd writes web.json just before it is ready; one from before the web app has none.
  for (let i = 0; i < 50; i++) {
    info = await readFile(file, 'utf8').then(JSON.parse, () => undefined);
    const current = await readLock(alpHome()).catch(() => undefined);
    if (info?.pid === current?.pid) break;
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
 * (ALPD §64). The device then signs in with the token that `alp web --print` shows.
 */

async function pairCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: 'boolean' }, off: { type: 'boolean' } } });
  if (positionals.length || (values.on && values.off)) throw new UsageError();
  await start();
  const client = await running();
  try {
    const pairing = await client.request('web.pairing', values.on ? { enable: true } : values.off ? { enable: false } : {});
    if (!pairing.relayEnabled) {
      console.log(`The relay is off${values.off ? ' now' : ''}. Turn it on with: alp web pair --on`);
      return;
    }
    console.log(`Relay ${pairing.endpoint}: ${pairing.connected ? 'connected' : 'connecting'}`);
    console.log(`Open this link on the device, or scan the QR code in the web app (Settings → host → Pair device):\n${pairing.url}`);
    console.log("When Paseo's app asks for a password, give it alpd's token: the part after #token= in alp web --print.");
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
