import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

const Pause = z.object({ reason: z.string(), since: z.string(), resetsAt: z.string().optional() });
export const usageGet = defineRpc({
  name: 'alp.usage.get',
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({
    providers: z.array(z.object({
      runtime: z.enum(['codex', 'claude']), available: z.boolean(), checkedAt: z.string(), plan: z.string().nullable(), limited: z.boolean(),
      windows: z.array(z.object({ name: z.string(), usedPercent: z.number().nullable(), resetsAt: z.string().nullable() })),
      pause: Pause.nullable(), parked: z.number(),
    })),
  }),
});
export type UsageData = z.infer<typeof usageGet.output>;
