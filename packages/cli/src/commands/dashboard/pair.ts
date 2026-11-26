import path from 'node:path';
import { parseArgs } from 'node:util';
import { alpHome } from '@anhlp/alp-client/index';
import { isAgentProcess } from '@anhlp/alp-core/tasks';
import { UsageError } from '../_shared/usage.ts';
import { running, start } from '../daemon/index.ts';
import { PASEO, readPaseoToken, startPaseoIntegration } from './paseo.ts';

/**
 * `web.pairing` is an extension the integration registers on its alpd connection. Right after an
 * alpd restart the old registration is gone and the new one may still be in flight, so an
 * unknown-method reply means "not yet", not "never": wait for the fresh registration.
 *
 * Exported so the wait can be pinned by a regression test without a live daemon restart.
 */
export async function requestPairing(
  client: { request(method: string, params?: unknown): Promise<any> }, // any: the integration's web.pairing answer
  params: { enable?: boolean },
  attempts = 50,
  // any: web.pairing's answer as the integration sends it (relayEnabled, url, endpoint, connected).
): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // any: the answer (see above), or the error the request failed with.
    const outcome: { value?: any; error?: any } = await client.request('web.pairing', params).then(value => ({ value }), error => ({ error }));
    if (!outcome.error) return outcome.value;
    last = outcome.error;
    const unknown = outcome.error?.code === -32601 || /unknown method|not available|not registered/i.test(outcome.error?.message ?? '');
    if (!unknown) throw outcome.error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last ?? new Error('alpd did not register web.pairing; run `alp dashboard pair` again to let the integration start');
}

/** Why the password could not be had, and what to do. */
const noPassword = (home: string, error: unknown) => `the Paseo integration did not give its password (${(error as Error | undefined)?.message ?? error}). An integration started by a version of ALP from before t-cde5 has no token socket: stop it (the pid in ${path.join(home, `${PASEO}.json`)}), then run alp dashboard pair again.`;

export async function pairCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: 'boolean' }, off: { type: 'boolean' }, rotate: { type: 'boolean' } } });
  if (positionals.length || (values.on && values.off)) throw new UsageError();
  // The password is the user's: an agent gets neither it nor a new one (alpd refuses its web.pairing too, t-d08b).
  if (isAgentProcess()) throw new Error('alp dashboard pair is the user\'s: it prints and rotates the password of the user\'s Paseo pairing; this process was started by an ALP agent (ALP_AGENT_SESSION is set)');
  await start();
  const home = alpHome();
  await startPaseoIntegration(home);
  const client = await running();
  try {
    // web.pairing first: alpd marks an agent's call and the integration refuses it before any password is read.
    const pairing = await requestPairing(client, values.on ? { enable: true } : values.off ? { enable: false } : {});
    if (values.rotate) {
      const { token } = await readPaseoToken(home, { rotate: true }).catch(error => { throw new Error(noPassword(home, error), { cause: error }); });
      console.log('The Paseo password is rotated: the old one no longer works, and every paired device must sign in again.');
      if (pairing.relayEnabled) console.log(`Open this link on the device that runs Paseo's app:\n${pairing.url}`);
      console.log(`When Paseo's app asks for a password, give it: ${token}`);
      return;
    }
    if (!pairing.relayEnabled) {
      console.log(`The relay is off${values.off ? ' now' : ''}. Turn it on with: alp dashboard pair --on`);
      return;
    }
    console.log(`Relay ${pairing.endpoint}: ${pairing.connected ? 'connected' : 'connecting'}`);
    console.log(`Open this link on the device that runs Paseo's app:\n${pairing.url}`);
    const { token } = await readPaseoToken(home).catch(error => { throw new Error(noPassword(home, error), { cause: error }); });
    console.log(`When Paseo's app asks for a password, give it: ${token}`);
  } finally {
    client.close();
  }
}
