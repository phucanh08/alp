import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import type { TimelineItem } from '@anhlp/alp-protocol';

type PaseoDetail = Extract<AgentTimelineItem, { type: 'tool_call' }>['detail'];

/**
 * A tool call's detail as Paseo's ToolCallDetail (ALPD §4.2). The typed shapes are Paseo's own;
 * a sub-agent's log (and, for older clients, actions) is required there; a detail type later than this version shows as unknown.
 */
export function paseoDetail(detail: Extract<TimelineItem, { kind: 'tool_call' }>['detail']): PaseoDetail {
  switch (detail.type) {
    case 'shell':
      return { type: 'shell', command: detail.command, ...(detail.cwd ? { cwd: detail.cwd } : {}), output: detail.output, ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}) };
    case 'read': case 'edit': case 'write': case 'search': case 'fetch': case 'plan': case 'plain_text':
      return { ...detail };
    case 'sub_agent':
      // Paseo clients up to 0.1.65-beta.3 require actions; Paseo's own producers still send [].
      return { ...detail, log: detail.log ?? '', actions: [] };
    default: {
      const other = detail as { input?: unknown; output?: unknown };
      return { type: 'unknown', input: (other.input ?? null) as never, output: (other.output ?? null) as never };
    }
  }
}
