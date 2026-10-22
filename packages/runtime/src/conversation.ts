import { ConversationError, type BranchRequest } from './contracts.js';

/**
 * Conversation cuts for fork and rewind (docs/protocol/alp-json-rpc-v1.md §12.7). Pure helpers of
 * runtime.ts's branch(): where a Claude transcript is cut, which Codex turn a fork must end at, and
 * what a Codex refusal means.
 */

/** One entry of a Claude session's main chain, as the Agent SDK reads it from the transcript. */
export type ChainEntry = { uuid: string; type: 'user' | 'assistant'; toolResult?: boolean };

const refuse = (reason: ConstructorParameters<typeof ConversationError>[0], message: string, outcomeUnknown = false) =>
  new ConversationError(reason, message, { outcomeUnknown });

/** The turn a Codex fork must end at, after ALP's own validation of the cut against its timeline. */
export function codexForkEnd(request: Pick<BranchRequest, 'cutoff' | 'turns'>) {
  const { cutoff, turns } = request;
  if (!cutoff) {
    if (!turns.length) throw refuse('empty_prefix', 'The conversation has no turn to fork');
    return { last: turns.at(-1)!, params: {} };
  }
  const id = 'beforeTurnId' in cutoff ? cutoff.beforeTurnId : cutoff.throughTurnId;
  const index = turns.indexOf(id);
  if (index < 0) throw refuse('boundary_unmapped', `Turn ${id} is not a turn of this conversation`);
  if ('beforeTurnId' in cutoff) {
    if (index === 0) throw refuse('empty_prefix', 'Nothing comes before the first turn');
    return { last: turns[index - 1], params: { beforeTurnId: id } };
  }
  return { last: id, params: { lastTurnId: id } };
}

/** What a refused thread/fork means; one written but unanswered may have forked. */
export function codexForkRefusal(error: unknown) {
  if (error instanceof ConversationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if ((error as { outcomeUnknown?: boolean })?.outcomeUnknown) return refuse('native_refused', `Codex did not answer the fork: ${message}`, true);
  if (/^turn not found\b/i.test(message)) return refuse('boundary_unmapped', `Codex does not know that turn: ${message}`);
  if (/identifies an in-progress turn/i.test(message)) return refuse('session_busy', `The turn is still running: ${message}`);
  return refuse('native_refused', `Codex refused the fork: ${message}`);
}

/**
 * The chain uuid a Claude fork resumes at (`resumeSessionAt`): the last entry kept. ALP turn ids are
 * the prompt uuids it gave Claude, so a turn starts at its prompt entry and runs to the next ALP turn's
 * prompt; entries of a turn Claude started itself belong to the turn before it. Always a pinned entry,
 * never "everything", so turns the source adds later never reach a branch made before them.
 */
export function claudeCut(chain: ChainEntry[], request: Pick<BranchRequest, 'cutoff' | 'turns'>): string {
  const { cutoff, turns } = request;
  const position = new Map(chain.map((entry, index) => [entry.uuid, index]));
  const prompt = (id: string) => {
    const index = position.get(id);
    return index !== undefined && chain[index].type === 'user' && !chain[index].toolResult ? index : undefined;
  };
  if (!cutoff) {
    if (!chain.length) throw refuse('empty_prefix', 'The conversation has no turn to fork');
    return chain.at(-1)!.uuid;
  }
  const id = 'beforeTurnId' in cutoff ? cutoff.beforeTurnId : cutoff.throughTurnId;
  const turn = turns.indexOf(id);
  const at = prompt(id);
  if (turn < 0 || at === undefined) throw refuse('boundary_unmapped', `Turn ${id} is not a turn of this conversation's transcript`);
  // ALP's turns found in the transcript must come in ALP's order, or the cut would not be what ALP shows.
  const found = turns.map(prompt).filter((index): index is number => index !== undefined);
  if (found.some((index, i) => i > 0 && index <= found[i - 1])) throw refuse('boundary_unmapped', 'The transcript orders turns differently from ALP');
  if ('beforeTurnId' in cutoff) {
    if (turn === 0 || at === 0) throw refuse('empty_prefix', 'Nothing comes before the first turn');
    return chain[at - 1].uuid;
  }
  // Through a turn: up to the prompt of the next ALP turn the transcript has, else its end.
  const next = turns.slice(turn + 1).map(prompt).find(index => index !== undefined);
  return chain[(next ?? chain.length) - 1].uuid;
}

/** The chain a binding stands for: a pending fork is its base cut at `at`, until its first prompt makes it. */
export function pendingChain(base: { at?: string }, chain: ChainEntry[]) {
  if (!base.at) return chain;
  const index = chain.findIndex(entry => entry.uuid === base.at);
  if (index < 0) throw refuse('native_refused', `The conversation no longer has the entry ${base.at} it was cut at`);
  return chain.slice(0, index + 1);
}
