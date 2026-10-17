#!/usr/bin/env node
// A deterministic stand-in for `codex app-server` for the web app's end-to-end tests: it speaks
// the JSON-RPC lines alpd's Codex transport sends and never calls a model. Every request it
// receives is appended to $FAKE_CODEX_JOURNAL (with thread/start's model and turn/start's effort). Markers in a prompt choose what its turn does:
//   (none)      stream "Echo: <prompt>" in a few deltas, then finish
//   [tool]      run a shell command (a commandExecution item with output), then answer
//   [ask]       ask the user with alp_ask; the turn ends once it is answered or declined
//   [ask-later] the same, about two seconds after the turn starts
//   [hold]      start and never finish (until interrupted)
//   [slow]      stream the answer over about three seconds
//   [usage:N]   first report token usage as Codex does: N tokens in a 258,400-token window, N-1000 of
//               them input (half cached) and 1000 output (thread/tokenUsage/updated)
// A steer (turn/steer) joins the running turn; one holding [finish] ends it with a reply.
// Images in a turn's input (data URLs) are journaled as { mimeType, bytes } and echoed as "(+N images)".
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const journal = process.env.FAKE_CODEX_JOURNAL;
const record = entry => { if (journal) appendFileSync(journal, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let threads = 0;
let turns = 0;
/** threadId → the turn running on it, so an interrupt ends it. */
const active = new Map();
/** alp_ask calls waiting for alpd's answer: request id → the turn that asked. */
const asking = new Map();

record({ method: 'spawn' });
process.on('SIGTERM', () => process.exit(0));

const textOf = params => (params?.input ?? []).filter(part => typeof part?.text === 'string').map(part => part.text).join('\n');
/** The images of a turn's input: each data URL's type and decoded size, never written out whole. */
const imagesOf = params => (params?.input ?? []).filter(part => part?.type === 'image' || part?.type === 'localImage').map(part => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(part.url ?? ''));
  return match ? { mimeType: match[1], bytes: Buffer.from(match[2], 'base64').length } : { type: part.type, ...(part.path ? { path: part.path } : {}), ...(part.url ? { url: String(part.url).slice(0, 64) } : {}) };
});
const live = (threadId, turnId) => active.get(threadId) === turnId;
/** The user's own words: ALP puts context (catalog, tasks) before them. */
const lastLine = text => text.split('\n').filter(line => line.trim() && !line.startsWith('<')).at(-1) ?? text;

async function stream(threadId, turnId, text, pause = 30) {
  const id = `msg-${turnId}`;
  const words = text.split(/(\s+)/);
  const chunk = Math.max(1, Math.ceil(words.length / 4));
  for (let i = 0; i < words.length; i += chunk) {
    if (!live(threadId, turnId)) return false;
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: id, delta: words.slice(i, i + chunk).join('') } });
    await sleep(pause);
  }
  if (!live(threadId, turnId)) return false;
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id, text } } });
  return true;
}

function complete(threadId, turnId) {
  if (!live(threadId, turnId)) return;
  active.delete(threadId);
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
}

async function run(threadId, turnId, text) {
  const used = /\[usage:(\d+)\]/.exec(text);
  if (used) {
    const total = Number(used[1]);
    const last = { totalTokens: total, inputTokens: total - 1000, cachedInputTokens: Math.floor((total - 1000) / 2), outputTokens: 1000, reasoningOutputTokens: 0 };
    send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: last, last, modelContextWindow: 258_400 } } });
    text = text.replace(used[0], '').trim();
  }
  const prompt = lastLine(text);
  if (text.includes('[tool]')) {
    const id = `cmd-${turnId}`;
    const command = 'ls -1 src';
    send({ method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id, command, cwd: '/workspace', status: 'inProgress', aggregatedOutput: '' } } });
    await sleep(150);
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id, command, cwd: '/workspace', status: 'completed', exitCode: 0, aggregatedOutput: 'app.ts\nindex.ts\nutil.ts\n' } } });
    if (await stream(threadId, turnId, 'The **src** folder has three files:\n\n- `app.ts`\n- `index.ts`\n- `util.ts`')) complete(threadId, turnId);
    return;
  }
  if (text.includes('[ask]') || text.includes('[ask-later]')) {
    const call = `ask-${turnId}`;
    asking.set(call, { threadId, turnId });
    await sleep(text.includes('[ask-later]') ? 2_000 : 50);
    send({ id: call, method: 'item/tool/call', params: { threadId, turnId, callId: `call-${turnId}`, namespace: null, tool: 'alp_ask', arguments: { question: 'Deploy to staging now?', options: ['yes', 'no'], to: 'user' } } });
    return;
  }
  if (text.includes('[hold]')) return;
  const slow = text.includes('[slow]');
  if (await stream(threadId, turnId, `Echo: ${prompt.replace(/\s*\[(slow)\]\s*/g, ' ').trim()}`, slow ? 700 : 30)) complete(threadId, turnId);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  // alpd's answer to an alp_ask this provider made.
  if (message.method === undefined) {
    const turn = asking.get(message.id);
    if (!turn) return;
    asking.delete(message.id);
    const raw = JSON.stringify(message.result ?? message.error ?? null);
    record({ method: 'tool/answered', threadId: turn.threadId, text: raw });
    // alp_ask answers with a JSON text item: { status: answered | dismissed, answer? }.
    let reply = raw;
    try {
      const inner = JSON.parse(message.result?.contentItems?.[0]?.text ?? 'null');
      reply = inner?.status === 'answered' ? `you said "${inner.answer}"` : `you declined (${inner?.status ?? 'no answer'})`;
    } catch {}
    void stream(turn.threadId, turn.turnId, `Answer received: ${reply}.`).then(done => { if (done) complete(turn.threadId, turn.turnId); });
    return;
  }
  const { id, method, params } = message;
  const text = textOf(params);
  const images = imagesOf(params);
  // The model a thread starts on and the effort of each turn, so tests can see what reached Codex.
  record({ method, ...(params?.threadId ? { threadId: params.threadId } : {}), ...(text ? { text } : {}), ...(typeof params?.model === 'string' ? { model: params.model } : {}), ...(typeof params?.effort === 'string' ? { effort: params.effort } : {}), ...(images.length ? { images } : {}) });
  const reply = result => send({ id, result });
  switch (method) {
    case 'initialize': return reply({});
    case 'thread/start': return reply({ thread: { id: `thread-${process.pid}-${++threads}` } });
    case 'thread/resume': return reply({ thread: { id: params.threadId } });
    case 'turn/start': {
      const turnId = `turn-${process.pid}-${++turns}`;
      reply({ turn: { id: turnId } });
      active.set(params.threadId, turnId);
      void run(params.threadId, turnId, images.length ? `${text} (+${images.length} image${images.length === 1 ? '' : 's'})` : text);
      return;
    }
    case 'turn/steer': {
      // Taken into the running turn; a [hold] turn then finishes with what it was told.
      const turnId = active.get(params.threadId);
      if (!turnId || (params.expectedTurnId && params.expectedTurnId !== turnId)) return send({ id, error: { code: -32600, message: 'no active turn to steer' } });
      reply({ turnId });
      if (text.includes('[finish]')) void stream(params.threadId, turnId, `Steered: ${lastLine(text).replace('[finish]', '').trim()}`).then(done => { if (done) complete(params.threadId, turnId); });
      return;
    }
    case 'turn/interrupt': {
      reply({});
      const turnId = active.get(params.threadId) ?? params.turnId;
      active.delete(params.threadId);
      send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'interrupted' } } });
      return;
    }
    default: return send({ id, error: { code: -32601, message: `fake codex does not know ${method}` } });
  }
});
