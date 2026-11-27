/**
 * terminal.* (§12.10): each call acts for its principal context; input, resize and the stream
 * belong to the connection that attached the terminal. alpd spreads them into its handler table
 * (server.ts).
 */
import { ERROR } from '@anhlp/alp-protocol';
import { RpcError } from '../../rpc/rpc-error.ts';
import { agentRefused, principalOf } from '../../rpc/helpers.ts';
import type { Connection } from '../../rpc/connection.ts';
import type { createTerminalService } from '../terminals.ts';

// any: params arrive as JSON; the service checks the fields it reads.
type TerminalHandler = (connection: Connection, params: any) => Promise<unknown> | unknown;
type TerminalMethod = 'terminal.create' | 'terminal.watch' | 'terminal.unwatch' | 'terminal.capture' | 'terminal.list' | 'terminal.attach' | 'terminal.input' | 'terminal.resize' | 'terminal.close' | 'terminal.revoke';

/** The handlers over this daemon's terminal service, or none (a daemon with no home). */
export function createTerminalHandlers({ terminals }: { terminals: ReturnType<typeof createTerminalService> | undefined }): Record<TerminalMethod, TerminalHandler> {
  const terminalCall = <T>(run: (service: NonNullable<typeof terminals>) => Promise<T>) => {
    if (!terminals) throw new RpcError(ERROR.unavailable, 'This alpd has no home: it serves no terminals', { reason: 'terminal_unsupported' });
    return run(terminals);
  };
  return {
    'terminal.create': (c, p) => agentRefused(c, 'terminal.create') ?? terminalCall(service => service.create(principalOf(p), p)),
    'terminal.watch': (c, p) => terminalCall(service => service.watch(principalOf(p), c, p)),
    'terminal.unwatch': (c) => terminalCall(service => service.unwatch(c)),
    'terminal.capture': (_c, p) => terminalCall(service => service.capture(principalOf(p), p)),
    'terminal.list': (_c, p) => terminalCall(service => service.list(principalOf(p), p)),
    'terminal.attach': (c, p) => agentRefused(c, 'terminal.attach') ?? terminalCall(service => service.attach(principalOf(p), c, p)),
    'terminal.input': (c, p) => agentRefused(c, 'terminal.input') ?? terminalCall(service => service.input(principalOf(p), c, p)),
    'terminal.resize': (c, p) => terminalCall(service => service.resize(principalOf(p), c, p)),
    'terminal.close': (_c, p) => terminalCall(service => service.close(principalOf(p), p)),
    'terminal.revoke': (_c, p) => terminalCall(service => service.revoke(p.principalId)),
  };
}
