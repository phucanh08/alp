#!/usr/bin/env node
// A stand-in for `codex app-server --listen stdio://` for alpd's crash-recovery tests (ALPD §66).
// It speaks the JSON-RPC lines CodexTransport sends and appends every request it receives to
// $FAKE_CODEX_JOURNAL, so a test can count what reached the provider across alpd restarts.
// Markers in a prompt choose what happens to its turn/start:
//   [kill-parent]  record it, then kill alpd before answering: received, never acknowledged
//   [die]          record it, then exit before answering: the provider dies mid-request
//   [hold]         answer, but never finish the turn
//   [slow]         answer after 200 ms
//   [ask]          answer, then ask the user with the alp_ask tool; the turn ends once it is answered
//   [usage]        report token usage as Codex does (thread/tokenUsage/updated) before the turn ends
// FAKE_CODEX_IGNORE_EOF=1 keeps it running after alpd goes away, as a stuck provider would.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const journal = process.env.FAKE_CODEX_JOURNAL;
const record = entry => { if (journal) appendFileSync(journal, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let threads = 0;
let turns = 0;
const active = new Map();
/** alp_ask calls waiting for alpd's answer: request id → the turn that asked. */
const asking = new Map();

record({ method: 'spawn', ppid: process.ppid });
if (process.env.FAKE_CODEX_IGNORE_EOF === '1') setInterval(() => {}, 1 << 30);
process.on('SIGTERM', () => { record({ method: 'sigterm' }); process.exit(0); });

const textOf = params => (params?.input ?? []).map(part => part.text ?? '').join('\n');

function finish(threadId, turnId, text) {
  active.delete(threadId);
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  // alpd's answer to a tool call this provider made.
  if (message.method === undefined) {
    const turn = asking.get(message.id);
    if (!turn) return;
    asking.delete(message.id);
    record({ method: 'tool/answered', threadId: turn.threadId, text: JSON.stringify(message.result ?? message.error ?? null) });
    finish(turn.threadId, turn.turnId, 'asked and answered');
    return;
  }
  const { id, method, params } = message;
  const text = textOf(params);
  record({ method, ...(params?.threadId ? { threadId: params.threadId } : {}), ...(text ? { text } : {}) });
  const reply = result => send({ id, result });
  switch (method) {
    case 'initialize': return reply({});
    case 'thread/start': return reply({ thread: { id: `thread-${process.pid}-${++threads}` } });
    case 'thread/resume': return reply({ thread: { id: params.threadId } });
    case 'turn/start': {
      if (text.includes('[kill-parent]')) { process.kill(process.ppid, 'SIGKILL'); return; }
      if (text.includes('[die]')) process.exit(3);
      const turnId = `turn-${process.pid}-${++turns}`;
      const start = () => {
        reply({ turn: { id: turnId } });
        active.set(params.threadId, turnId);
        if (text.includes('[usage]')) send({ method: 'thread/tokenUsage/updated', params: { threadId: params.threadId, turnId, tokenUsage: { total: { totalTokens: 52_000, inputTokens: 50_000, cachedInputTokens: 40_000, outputTokens: 2000, reasoningOutputTokens: 500 }, last: { totalTokens: 26_000, inputTokens: 25_000, cachedInputTokens: 20_000, outputTokens: 1000, reasoningOutputTokens: 250 }, modelContextWindow: 258_400 } } });
        if (text.includes('[ask]')) {
          const call = `ask-${turnId}`;
          asking.set(call, { threadId: params.threadId, turnId });
          setTimeout(() => send({ id: call, method: 'item/tool/call', params: { threadId: params.threadId, turnId, callId: `call-${turnId}`, namespace: null, tool: 'alp_ask', arguments: { question: 'Go on?', to: 'user' } } }), 20);
        } else if (!text.includes('[hold]')) setTimeout(() => finish(params.threadId, turnId, `ok ${turns}`), 20);
      };
      if (text.includes('[slow]')) setTimeout(start, 200); else start();
      return;
    }
    case 'turn/interrupt': {
      reply({});
      active.delete(params.threadId);
      send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } });
      return;
    }
    default: return send({ id, error: { code: -32601, message: `fake codex does not know ${method}` } });
  }
});
// alpd went away: a real provider exits when its stdin closes.
lines.on('close', () => { record({ method: 'eof' }); if (process.env.FAKE_CODEX_IGNORE_EOF !== '1') process.exit(0); });
