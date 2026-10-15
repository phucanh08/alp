import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { alpHome, connect } from '@anhlp/alp-client/index';
import { startDaemon } from '@anhlp/alp-client/supervise';
import { createLogger } from '@anhlp/alp-core/log';
import { createAcpAgent } from './agent.js';

declare const __ALP_VERSION__: string;

/** `alp acp`: serves the Agent Client Protocol on stdio until the editor closes it (ALPD §60). */
export async function runAcp({ daemonEntry }: { daemonEntry: string }) {
  const version = typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : '0.0.0';
  // Stdout is the protocol stream; diagnostics are structured lines on stderr only.
  const logger = createLogger({ component: 'acp' });
  const log = (message: string, fields?: { code?: string; error?: unknown }) => logger.warn(message, fields);
  const app = createAcpAgent({
    version,
    log,
    connect: async () => connect(await startDaemon({ home: alpHome(), entry: daemonEntry }), { name: 'alp-acp', version }),
  });
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const connection = app.connect(stream);
  await connection.closed;
}
