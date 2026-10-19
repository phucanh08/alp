// Hermetic Claude Code protocol stand-in. Invoked by the real Agent SDK; no model.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const partials = process.argv.includes('--include-partial-messages');
const event = event => send({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'fixture', uuid: crypto.randomUUID() });
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } });
  } else if (value.type === 'user') {
    if (partials) {
      event({ type: 'message_start', message: { id: 'sdk-message', content: [] } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'draft' } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_stop' });
    }
    send({ type: 'assistant', parent_tool_use_id: null, uuid: 'final-sdk-block', session_id: 'fixture', message: { id: 'sdk-message', content: [{ type: 'text', text: 'final' }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }
}
