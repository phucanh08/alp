import { runBridge } from '@anhlp/alp-core/bridges';
import { UsageError } from '../_shared/usage.ts';

/** alp bridge acp|antigravity: the stdio MCP bridge an agent CLI starts to reach alpd's tools. */
export function bridgeCommand(args: string[]) {
  if (args.length !== 1 || !['acp', 'antigravity'].includes(args[0])) throw new UsageError();
  runBridge(args[0]);
}
