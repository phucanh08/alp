/**
 * Main's compaction (t-0e56): at a turn boundary, once main's context fills to the
 * threshold (or the user asks), ALP has main write a checkpoint by skill `compact`,
 * then compacts with the runtime's own mechanism (Claude's /compact, Codex's
 * thread/compact/start), or else starts a fresh conversation seeded with the checkpoint.
 */

export interface CompactSettings { auto: boolean; threshold: number }

export const COMPACT_DEFAULTS: CompactSettings = Object.freeze({ auto: true, threshold: 0.7 });

/** settings.json `compact`: { auto?: boolean, threshold?: number in (0, 1) }; anything else keeps the default. */
export function compactSettings(raw: unknown): CompactSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const auto = typeof value.auto === 'boolean' ? value.auto : COMPACT_DEFAULTS.auto;
  const threshold = typeof value.threshold === 'number' && Number.isFinite(value.threshold) && value.threshold > 0 && value.threshold < 1 ? value.threshold : COMPACT_DEFAULTS.threshold;
  return { auto, threshold };
}

/** How full the context is, 0..1, from a runtime's token usage; undefined when the window is unknown. */
export function contextFill(usage: any): number | undefined {
  const used = usage?.last?.totalTokens;
  const window = usage?.modelContextWindow;
  if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) return undefined;
  return used / window;
}

/** Whether an idle root should compact now. */
export function compactDue(settings: CompactSettings, fill: number | undefined, requested: boolean): 'auto' | 'manual' | undefined {
  if (requested) return 'manual';
  if (settings.auto && typeof fill === 'number' && fill >= settings.threshold) return 'auto';
  return undefined;
}

/** Runtimes that compact a conversation in place. */
export const NATIVE_COMPACT = ['claude', 'codex'];

export const CHECKPOINT_MARK = 'ALP compact checkpoint';

export function checkpointPrompt(trigger: 'auto' | 'manual', fill?: number) {
  const why = trigger === 'manual' ? 'The user asked to compact your context.' : `Your context is about ${Math.round((fill ?? 0) * 100)}% full.`;
  return `${CHECKPOINT_MARK}: ${why} ALP compacts it after this turn. Write a checkpoint now following skill compact (read its SKILL.md): check the facts with alp_task, alp_board and gh where it applies, then reply with the checkpoint alone, in its sections. Do not start new work, delegate, wait or ask in this turn.`;
}

/** What the runtime's native compaction is told to keep. */
export function compactInstructions(checkpoint: string) {
  return `Keep this checkpoint verbatim in the summary; it is the state of the work:\n${checkpoint}`;
}

/** The first prompt of a fresh conversation that replaces a full one. */
export function seedPrompt(checkpoint: string, lastUser?: string) {
  return [
    'Your context was compacted: ALP started this conversation fresh. Your instructions are unchanged. This is the checkpoint you wrote before, by skill compact:',
    checkpoint,
    ...(lastUser ? [`The user's last message before the compaction, verbatim:\n${lastUser}`] : []),
    'Read alp_task and alp_board again (and gh for PR/CI) before reporting status, then carry on. If nothing waits for you, end the turn.',
  ].join('\n\n');
}
