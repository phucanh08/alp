// Hermetic Claude Code protocol stand-in that records how the real Agent SDK started it: its
// arguments, then each prompt's uuid and session. No model. With ALP_FAKE_CLAUDE_REFUSE it refuses
// at boot as Claude refuses a resume: an error result before any prompt, then it exits.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = value => { if (process.env.ALP_FAKE_CLAUDE_RECORD) appendFileSync(process.env.ALP_FAKE_CLAUDE_RECORD, `${JSON.stringify(value)}\n`); };
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
record({ argv: process.argv.slice(2) });
if (process.env.ALP_FAKE_CLAUDE_REFUSE) {
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0, session_id: 'fixture', uuid: crypto.randomUUID(), errors: [process.env.ALP_FAKE_CLAUDE_REFUSE] });
  process.stdout.end(() => process.exit(1));
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const value = JSON.parse(line);
    if (value.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } });
    } else if (value.type === 'user') {
      record({ prompt: value.uuid, session: value.session_id });
      send({ type: 'assistant', parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: 'fixture', message: { id: `reply-${value.uuid}`, content: [{ type: 'text', text: 'ok' }] } });
      send({ type: 'result', subtype: 'success', is_error: false });
    }
  }
}
