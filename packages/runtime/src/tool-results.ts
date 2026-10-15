import { promptSafe } from '@anhlp/alp-core/promptsafe';
import { scrubText } from '@anhlp/alp-core/log';

export const errorData = (error: unknown) => ({
  // It reaches timelines, run logs and clients: a provider's complaint may quote a credential.
  message: scrubText(error instanceof Error ? error.message : String(error)),
  // A transport marks a request the provider may have received before it failed (ALPD §66).
  ...((error as { outcomeUnknown?: boolean } | null)?.outcomeUnknown ? { code: 'outcome_unknown' } : {}),
});

export const toolResult = (
    success: boolean,
    value: unknown,
  ) => ({
    success,
    contentItems: [
      {
        type: 'inputText',
        // Results carry what other agents wrote and commands printed.
        text: promptSafe(JSON.stringify(value)),
      },
    ],
  });

export const plainObject = (value: unknown, keys: string[]): value is Record<string, any> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
