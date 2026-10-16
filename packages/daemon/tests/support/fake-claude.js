#!/usr/bin/env node
// A stand-in for the Claude Code executable that ClaudeTransport launches through the Claude Agent
// SDK's query() (`--output-format stream-json --verbose --input-format stream-json ...`), for
// hermetic tests, `alp doctor` and the fake acceptance run. No model is called. It speaks the SDK's
// stream-json lines and its control protocol (initialize, interrupt, set_permission_mode, set_model,
// get_usage, get_context_usage, mcp_status), and appends what it receives to $FAKE_CLAUDE_JOURNAL.
// Every prompt is answered `ok N: <prompt>` (its last text part, after the context ALP puts first),
// then its turn ends with a success result; a prompt sent mid-turn is answered within that turn.
// A marker in a prompt chooses what happens to its turn:
//   [hold]         answer, but never finish the turn until an interrupt ends it
// `--session-id=<id>` names a new session and `--resume=<id>` keeps the resumed id (with
// `--fork-session`, the new --session-id). `--version` and `auth status` answer as the real CLI does.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const VERSION = '2.1.0 (Claude Code)';
const args = process.argv.slice(2);
const journal = process.env.FAKE_CLAUDE_JOURNAL;
const record = entry => { if (journal) appendFileSync(journal, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

if (args[0] === '--version' || args[0] === '-v') {
  console.log(VERSION);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  // The real CLI prints JSON unless asked for --text; `alp doctor` reads loggedIn.
  if (args.includes('--text')) console.log('Logged in as fake@example.invalid (fake Claude)');
  else console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'fake@example.invalid', subscriptionType: 'max' }, null, 2));
  process.exit(0);
}

/** The value of `--name=value` or `--name value`; true for a bare flag. */
function option(name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
    if (args[i] === `--${name}`) return args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[i + 1];
  }
  return undefined;
}
const resume = option('resume');
const fork = option('fork-session') !== undefined;
const sessionId = (typeof resume === 'string' && !fork ? resume : option('session-id')) || randomUUID();
let model = typeof option('model') === 'string' ? option('model') : 'claude-sonnet-4-5';
let permissionMode = typeof option('permission-mode') === 'string' ? option('permission-mode') : 'default';
const MODELS = [
  { value: 'default', displayName: 'Default', description: 'The fake default model', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'The fake Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'opus', displayName: 'Opus', description: 'The fake Opus', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: 'The fake Haiku' },
];
const WINDOW = 200_000;

record({ method: 'spawn', ppid: process.ppid, sessionId, ...(resume ? { resume } : {}), ...(fork ? { fork } : {}), args });
process.on('SIGTERM', () => { record({ method: 'sigterm' }); process.exit(0); });

let turns = 0;
const started = Date.now();
/** The turn running now: held ones wait here for an interrupt. */
let active;

const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const tokens = text => Math.max(1, Math.ceil(text.length / 4));
const totals = { input: 0, output: 0 };
const modelUsage = () => ({ [model]: { inputTokens: totals.input, outputTokens: totals.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: WINDOW, maxOutputTokens: 32_000 } });
/** A user message's text parts; ALP puts its own context first and the prompt last. */
const partsOf = message => {
  const content = message?.message?.content;
  return typeof content === 'string' ? [content] : (Array.isArray(content) ? content : []).map(part => part.text ?? '');
};

let messages = 0;
/** One assistant text message of `turn`, answering `text`: it repeats the prompt, its last part. */
function reply(turn, text, prompt) {
  const answer = text.includes('[hold]') ? `holding ${turn.n}` : `ok ${turn.n}: ${prompt.slice(0, 2000)}`;
  const input = tokens(text), output = tokens(answer);
  totals.input += input;
  totals.output += output;
  turn.input += input;
  turn.output += output;
  turn.answer = answer;
  send({
    type: 'assistant', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
    message: { id: `msg_fake_${process.pid}_${++messages}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: answer }], stop_reason: turn.held ? null : 'end_turn', stop_sequence: null, usage: usage(input, output) },
  });
}

function startTurn(text, prompt) {
  const turn = { n: ++turns, started: Date.now(), input: 0, output: 0, held: text.includes('[hold]') };
  active = turn;
  send({
    type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), cwd: process.cwd(), model, permissionMode,
    apiKeySource: 'none', claude_code_version: VERSION.split(' ')[0], tools: [], mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [],
  });
  reply(turn, text, prompt);
  if (!turn.held) setTimeout(() => endTurn(turn, { subtype: 'success', is_error: false, result: turn.answer, stop_reason: 'end_turn', terminal_reason: 'completed' }), 20);
}

function endTurn(turn, outcome) {
  if (active !== turn) return;
  active = undefined;
  const elapsed = Date.now() - turn.started;
  send({
    type: 'result', session_id: sessionId, uuid: randomUUID(), duration_ms: elapsed, duration_api_ms: elapsed, num_turns: 1,
    total_cost_usd: 0, usage: usage(turn.input, turn.output), modelUsage: modelUsage(), permission_denials: [], ...outcome,
  });
  record({ method: 'turn/end', subtype: outcome.subtype, n: turn.n });
}

/** The answer to each control request ClaudeTransport and the SDK send; anything else is refused. */
function control(request) {
  switch (request.subtype) {
    case 'initialize':
      return {
        commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: MODELS,
        account: { email: 'fake@example.invalid', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' },
      };
    case 'set_permission_mode': permissionMode = request.mode; return {};
    case 'set_model': model = request.model ?? model; return {};
    case 'mcp_status': return { mcpServers: [] };
    case 'get_usage':
      return {
        session: { total_cost_usd: 0, total_api_duration_ms: Date.now() - started, total_duration_ms: Date.now() - started, total_lines_added: 0, total_lines_removed: 0, model_usage: modelUsage() },
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 0, resets_at: null } },
      };
    case 'get_context_usage': {
      const used = totals.input + totals.output;
      return {
        categories: [], totalTokens: used, maxTokens: WINDOW, rawMaxTokens: WINDOW, percentage: Math.round(used / WINDOW * 100), gridRows: [],
        model, memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: WINDOW - 33_000,
      };
    }
    case 'interrupt': return { still_queued: [] };
    default: throw new Error(`fake claude does not know ${request.subtype}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const { request_id, request } = message;
    record({ method: request.subtype, ...(request.mode ? { mode: request.mode } : {}), ...(request.model ? { model: request.model } : {}) });
    try {
      send({ type: 'control_response', response: { subtype: 'success', request_id, response: control(request) } });
    } catch (error) {
      send({ type: 'control_response', response: { subtype: 'error', request_id, error: error.message } });
      return;
    }
    // As the real CLI: the interrupt's receipt first, then the interrupted turn's result.
    if (request.subtype === 'interrupt') {
      if (active) {
        send({ type: 'user', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
        endTurn(active, { subtype: 'error_during_execution', is_error: true, errors: [], stop_reason: null, terminal_reason: 'aborted_streaming' });
      }
    }
    return;
  }
  if (message.type !== 'user') return; // control_response, control_cancel_request, keep_alive: nothing to do
  const parts = partsOf(message);
  const text = parts.join('\n');
  const prompt = parts.at(-1) ?? '';
  record({ method: 'user', sessionId, text });
  // A prompt sent while a turn runs (ALP's steer) is folded into it, as the CLI folds queued prompts.
  if (active) reply(active, text, prompt); else startTurn(text, prompt);
});
// The SDK closes stdin when the query ends: a real CLI exits then.
lines.on('close', () => { record({ method: 'eof' }); process.exit(0); });
