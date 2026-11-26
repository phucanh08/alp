// t-7679.13: ALP's typed tool-call details reach Paseo as its own ToolCallDetail shapes; a sub-agent
// gets the log Paseo requires, and a detail type later than this version shows as unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineDeltas, paseoDetail } from '@anhlp/alp-paseo/paseo/timeline-items';

const call = (detail, extra = {}) => ({ kind: 'tool_call', id: 't1', callId: 't1', name: 'Read', status: 'completed', detail, ...extra });

test('typed details pass to Paseo as they are; shell and unknown as before', () => {
  const typed = [
    { type: 'read', filePath: '/p/a.ts', content: 'x', offset: 1, limit: 10 },
    { type: 'edit', filePath: '/p/a.ts', oldString: 'a', newString: 'b', unifiedDiff: '@@\n-a\n+b\n' },
    { type: 'write', filePath: '/p/n.md', content: '# N' },
    { type: 'search', query: 'TODO', toolName: 'grep', filePaths: ['a.ts'], numFiles: 1, numMatches: 2, truncated: false },
    { type: 'search', query: 'acp', toolName: 'web_search', webResults: [{ title: 'ACP', url: 'https://agentclientprotocol.com' }] },
    { type: 'fetch', url: 'https://x.dev', prompt: 'Sum', result: 'S', code: 200 },
    { type: 'plan', text: '1. Fix' },
    { type: 'plain_text', label: 'alp:xia', text: 'Launching' },
  ];
  for (const detail of typed) assert.deepEqual(paseoDetail(detail), detail);
  assert.deepEqual(paseoDetail({ type: 'sub_agent', subAgentType: 'Explore', description: 'Find it' }), { type: 'sub_agent', subAgentType: 'Explore', description: 'Find it', log: '', actions: [] });
  assert.deepEqual(paseoDetail({ type: 'sub_agent', log: 'report' }).log, 'report');
  assert.deepEqual(paseoDetail({ type: 'shell', command: 'npm test', output: 'ok', exitCode: 0 }), { type: 'shell', command: 'npm test', output: 'ok', exitCode: 0 });
  assert.deepEqual(paseoDetail({ type: 'unknown', input: { a: 1 }, output: undefined }), { type: 'unknown', input: { a: 1 }, output: null });
  // A later detail type: unknown, with its input and output if it has them.
  assert.deepEqual(paseoDetail({ type: 'diagram', input: { src: 'x' } }), { type: 'unknown', input: { src: 'x' }, output: null });
});

test('the timeline log appends a typed call, and its failure with the error', () => {
  const deltas = new TimelineDeltas();
  assert.deepEqual(deltas.next(call({ type: 'read', filePath: '/p/a.ts' }, { status: 'running' })), { type: 'tool_call', callId: 't1', name: 'Read', status: 'running', error: null, detail: { type: 'read', filePath: '/p/a.ts' } });
  assert.deepEqual(deltas.next(call({ type: 'read', filePath: '/p/a.ts' }, { status: 'failed', error: 'File does not exist.' })), { type: 'tool_call', callId: 't1', name: 'Read', status: 'failed', error: 'File does not exist.', detail: { type: 'read', filePath: '/p/a.ts' } });
});
