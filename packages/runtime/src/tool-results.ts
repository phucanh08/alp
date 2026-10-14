import { promptSafe } from '@anhlp/alp-core/promptsafe';

export const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
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
