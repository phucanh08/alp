#!/usr/bin/env node
// A scripted ACP agent for tests (ALPD §46). It speaks ACP v1 on stdio and acts on
// lines of the last prompt block that start with "fake:":
//   fake:say TEXT               answer with TEXT
//   fake:tools                  list the tools of the MCP server named alp
//   fake:tool NAME JSON         call that ALP tool through the alp MCP server
//   fake:permit KIND TEXT       ask permission for a KIND tool call (TEXT is its command or title)
//   fake:exec COMMAND           report a command it ran
//   fake:call JSON              report a tool call: JSON is {kind, title, rawInput, locations, rawOutput, content,
//                               status} of its last update; with `running` (another update), kind and title go
//                               first, the rest in a running update, then the last one; with `late`, one more
//                               running update after it
//   fake:usage USED SIZE [USD]  report how full its context is, and the session's cost in US dollars
//   fake:tokens IN OUT CACHED   end the turn with that usage in the prompt response
//   fake:hang                   wait until ALP cancels the turn
//   fake:fail                   fail the prompt
//   fake:exit                   die mid-turn
// FAKE_ACP_LOG names a file each message from ALP is appended to; FAKE_ACP_LOAD=1
// offers session/load; FAKE_ACP_IMAGES=1 takes images in a prompt (promptCapabilities.image); FAKE_ACP_MODELS=a,b offers models to choose from.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// `any`: ACP and MCP messages are JSON of every shape; this fake reads only the fields each scenario sends.
type Message = any;
/** An MCP server entry of session/new: how to start it. */
type McpServer = { name: string, command: string, args?: string[], env?: { name: string, value: string }[] };

const log = (message: Message) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(message) + '\n'); };
const send = (value: Message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const sessions = new Map<string, { prompts: number, alp: McpServer }>();
const waiting = new Map<number, (message: Message) => void>();
let sequence = 1000;
let cancel: (() => void) | undefined;

const ask = (method: string, params: Message) => new Promise<Message>(resolve => { const id = ++sequence; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId: string, value: Message) => send({ method: 'session/update', params: { sessionId, update: value } });
const say = (sessionId: string, text: string) => {
  // In two chunks, as agents stream.
  const half = Math.ceil(text.length / 2);
  for (const part of [text.slice(0, half), text.slice(half)]) if (part) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
};

/** A tiny MCP client for one call to the alp server. */
async function mcp(server: McpServer, method: string, params: Message): Promise<Message> {
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map(entry => [entry.name, entry.value])) };
  const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map<number, (message: Message) => void>();
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); replies.get(message.id)?.(message); });
  const request = (id: number, name: string, args: Message) => new Promise<Message>(resolve => { replies.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: name, params: args }) + '\n'); });
  try {
    await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await request(2, method, params);
  } finally { child.stdin.end(); child.kill(); }
}

async function prompt(id: number, { sessionId, prompt: blocks }: { sessionId: string, prompt: { type: string, text?: string }[] }) {
  // A prompt names a session this fake created (as before, an unknown one throws).
  const session = sessions.get(sessionId)!;
  session.prompts += 1;
  const text = blocks.filter(block => block.type === 'text').at(-1)?.text ?? '';
  const lines = text.split('\n').filter(line => line.startsWith('fake:'));
  if (!lines.length) lines.push('fake:say ok');
  let usage: Record<string, number> | undefined;
  for (const line of lines) {
    const [verb, ...rest] = line.slice(5).split(' ');
    const argument = rest.join(' ');
    if (verb === 'say') say(sessionId, argument);
    else if (verb === 'tools') {
      const reply = await mcp(session.alp, 'tools/list', {});
      say(sessionId, `tools: ${reply.result.tools.map((tool: { name: string }) => tool.name).join(',')}`);
    } else if (verb === 'tool') {
      const [name, ...json] = rest;
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `call-${++sequence}`, title: `alp: ${name}`, kind: 'other', status: 'pending' });
      const reply = await mcp(session.alp, 'tools/call', { name, arguments: JSON.parse(json.join(' ') || '{}') });
      say(sessionId, `tool ${name}: ${reply.result.isError ? 'error ' : ''}${reply.result.content.map((part: { text: string }) => part.text).join('')}`);
    } else if (verb === 'permit') {
      const [kind, ...what] = rest;
      const toolCallId = `call-${++sequence}`;
      const toolCall = { toolCallId, title: what.join(' '), kind, status: 'pending', ...(kind === 'execute' ? { rawInput: { command: what.join(' ') } } : {}), ...(kind === 'edit' ? { locations: [{ path: what.join(' ') }] } : {}) };
      update(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
      const reply = await ask('session/request_permission', { sessionId, toolCall, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
      const outcome = reply.result?.outcome;
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: outcome?.optionId === 'yes' || outcome?.optionId === 'always' ? 'completed' : 'failed' });
      say(sessionId, `permission: ${outcome?.outcome === 'selected' ? outcome.optionId : outcome?.outcome}`);
    } else if (verb === 'exec') {
      const toolCallId = `call-${++sequence}`;
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: argument, kind: 'execute', status: 'in_progress', rawInput: { command: argument } });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `ran ${argument}` } }] });
    } else if (verb === 'call') {
      const { kind, title, status = 'completed', running, late, ...rest } = JSON.parse(argument);
      const toolCallId = `call-${++sequence}`;
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', ...(running ? {} : { rawInput: rest.rawInput, locations: rest.locations }) });
      if (running) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', ...(rest.rawInput ? { rawInput: rest.rawInput } : {}), ...(rest.locations ? { locations: rest.locations } : {}) });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status, ...(rest.content ? { content: rest.content } : {}), ...(rest.rawOutput !== undefined ? { rawOutput: rest.rawOutput } : {}) });
      if (late) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', kind: 'other' });
    } else if (verb === 'usage') update(sessionId, { sessionUpdate: 'usage_update', used: Number(rest[0]), size: Number(rest[1]), ...(rest[2] ? { cost: { amount: Number(rest[2]), currency: 'USD' } } : {}) });
    else if (verb === 'tokens') usage = { inputTokens: Number(rest[0]), outputTokens: Number(rest[1]), cachedReadTokens: Number(rest[2]), totalTokens: Number(rest[0]) + Number(rest[1]) };
    else if (verb === 'hang') { await new Promise<void>(resolve => { cancel = resolve; }); return send({ id, result: { stopReason: 'cancelled' } }); }
    else if (verb === 'fail') return send({ id, error: { code: -32603, message: 'fake failure' } });
    else if (verb === 'exit') process.exit(3);
  }
  send({ id, result: { stopReason: 'end_turn', ...(usage ? { usage } : {}) } });
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log(message);
  if (message.id !== undefined && !message.method) { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve?.(message); return; }
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' }, agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD === '1', mcpCapabilities: { http: false }, ...(process.env.FAKE_ACP_IMAGES === '1' ? { promptCapabilities: { image: true } } : {}) }, authMethods: [] } });
  } else if (method === 'session/new' || method === 'session/load') {
    const sessionId = method === 'session/load' ? params.sessionId : `fake-session-${++sequence}`;
    sessions.set(sessionId, { prompts: 0, alp: params.mcpServers.find((server: McpServer) => server.name === 'alp') });
    // A loaded session replays its history first.
    if (method === 'session/load') say(sessionId, 'replayed history');
    const models = process.env.FAKE_ACP_MODELS ? { models: { currentModelId: process.env.FAKE_ACP_MODELS.split(',')[0], availableModels: process.env.FAKE_ACP_MODELS.split(',').map(modelId => ({ modelId, name: modelId })) } } : {};
    const configOptions = process.env.FAKE_ACP_CONFIG ? [{ id: 'model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] }] : undefined;
    send({ id, result: method === 'session/new' ? { sessionId, ...(configOptions ? { configOptions } : models) } : {} });
  } else if (method === 'session/set_config_option') send({ id, result: {} });
  else if (method === 'session/set_model') send({ id, result: {} });
  else if (method === 'session/prompt') void prompt(id, params);
  else if (method === 'session/cancel') cancel?.();
  else if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
});
process.stdin.on('end', () => process.exit(0));
