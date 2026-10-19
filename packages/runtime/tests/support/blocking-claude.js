// Hermetic Claude Code protocol stand-in, invoked by the real Agent SDK; no model. On the first
// prompt it streams a reply, then calls the ALP tool alp_ask through the SDK's in-process MCP
// server and waits for its answer before it ends the turn, as Claude does with a blocking tool.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = event => send({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'fixture', uuid: crypto.randomUUID() });
const waiting = new Map();
let next = 0;
/** Sends an MCP message to the SDK's server and resolves with its answer. */
const mcp = message => new Promise(resolve => {
  const request_id = `cli-${++next}`;
  waiting.set(request_id, resolve);
  send({ type: 'control_request', request_id, request: { subtype: 'mcp_message', server_name: 'alp', message } });
});

async function turn() {
  event({ type: 'message_start', message: { id: 'before-tool', content: [] } });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply written before the blocking call.' } });
  event({ type: 'content_block_stop', index: 0 });
  const tool = { type: 'tool_use', id: 'toolu-ask', name: 'mcp__alp__alp_ask', input: { question: 'Which option?' } };
  send({ type: 'assistant', parent_tool_use_id: null, uuid: 'before-tool-text', session_id: 'fixture', message: { id: 'before-tool', content: [{ type: 'text', text: 'Reply written before the blocking call.' }] } });
  send({ type: 'assistant', parent_tool_use_id: null, uuid: 'before-tool-call', session_id: 'fixture', message: { id: 'before-tool', content: [tool] } });
  await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
  await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const answer = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'alp_ask', arguments: tool.input } });
  const text = answer?.mcp_response?.result?.content?.[0]?.text ?? '';
  send({ type: 'user', parent_tool_use_id: null, session_id: 'fixture', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: text }] } });
  send({ type: 'assistant', parent_tool_use_id: null, uuid: 'after-tool', session_id: 'fixture', message: { id: 'after-tool', content: [{ type: 'text', text: 'Thanks for answering.' }] } });
  send({ type: 'result', subtype: 'success', is_error: false });
}

for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } });
  } else if (value.type === 'control_response') {
    const resolve = waiting.get(value.response?.request_id);
    waiting.delete(value.response?.request_id);
    resolve?.(value.response?.response);
  } else if (value.type === 'user') {
    void turn();
  }
}
