import { UsageError } from '../_shared/usage.js';
import { built } from '../daemon/index.js';
import { DAEMON_ENTRY, distributionEntry } from '../../paths.js';

/** alp acp: ALP as an ACP agent for editors; stdout carries only the protocol (ALPD §60). */

export async function acpCommand(args: string[]) {
  if (args.length) throw new UsageError();
  await built();
  const { runAcp } = (await import(distributionEntry('acp.js').href)) as { runAcp: (options: { daemonEntry: string }) => Promise<void> };
  await runAcp({ daemonEntry: DAEMON_ENTRY });
}
