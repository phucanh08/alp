#!/usr/bin/env node
// Writes fixtures/v1/cases.json, the golden v1 values. Edit the cases here, run it, and commit both.
import { writeFileSync } from 'node:fs';
const out = process.argv[2] ?? new URL('../fixtures/v1/cases.json', import.meta.url);
const ts = '2026-10-15T00:00:00.000Z';
const snapshot = { id: 'ses_fixture', projectRoot: '/work/project', agent: 'main', runtime: 'codex', model: 'gpt-6.1-sol', mode: 'workspace-write', thinking: 'low', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, teamLabel: 'Phở', threadId: 'thread-1', persistent: true, busy: false };
const summary = { ...snapshot, status: 'idle', title: 'Sửa lỗi 😀', createdAt: ts, updatedAt: ts };
const question = { id: 'q_1', sessionId: 'ses_fixture', rootId: 'ses_fixture', agent: 'main', body: 'Tiếp tục?', options: ['có', 'không'], askedAt: ts };
const pin = { id: 'pin_1', project: '/work/project', kind: 'claim', body: 'Đang sửa server', paths: ['src/server.ts'], agent: 'peer', sessionId: 'ses_child', rootId: 'ses_fixture', at: ts };
const pauses = { runtimes: { claude: { since: ts, by: 'the user', reason: 'limit', resetsAt: ts } }, parked: [{ assignmentId: 'a_1', agent: 'peer', runtime: 'claude', rootId: 'ses_fixture', reason: 'limit', since: ts }] };
const env = (event, extra = {}) => ({ sessionId: 'ses_fixture', epoch: 'epoch-1', seq: 3, cursor: 12, ts, event, ...extra });
const cases = [];
const add = (check, name, value, valid = true, method) => cases.push({ name, check, ...(method ? { method } : {}), valid, value });

// messages
add('message', 'request', { jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: 1, client: { name: 'fixture', version: '0.9.5' } } });
add('message', 'request with a string id', { jsonrpc: '2.0', id: 'req-é', method: 'session.list' });
add('message', 'success response', { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, daemonVersion: '0.10.0', pid: 42, capabilities: ['attach.after', 'extension.methods'] } });
add('message', 'error response', { jsonrpc: '2.0', id: 2, error: { code: 1001, message: 'No session ses_fixture' } });
add('message', 'error response with id null', { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
add('message', 'event notification', { jsonrpc: '2.0', method: 'event', params: env({ type: 'session.ready' }) });
add('message', 'extension.invoke request to an owner', { jsonrpc: '2.0', id: 3, method: 'extension.invoke', params: { method: 'web.pairing', params: {} } });
add('message', 'request without jsonrpc', { id: 1, method: 'daemon.status' }, false);
add('message', 'request with a fractional id', { jsonrpc: '2.0', id: 1.5, method: 'daemon.status' }, false);
add('message', 'request with an id beyond 2^53-1', { jsonrpc: '2.0', id: 9007199254740992, method: 'daemon.status' }, false);
add('message', 'request with array params', { jsonrpc: '2.0', id: 1, method: 'session.get', params: ['ses_fixture'] }, false);
add('message', 'response with result and error', { jsonrpc: '2.0', id: 1, result: {}, error: { code: 1000, message: 'x' } }, false);
add('message', 'error without message', { jsonrpc: '2.0', id: 1, error: { code: 1000 } }, false);
add('message', 'batch', [{ jsonrpc: '2.0', id: 1, method: 'daemon.status' }], false);

// envelopes: every event type and item kind
const events = [
  { type: 'session.opened', session: snapshot, cwd: '/work/project', effective: { model: 'gpt-6.1-sol', thinking: 'low' } },
  { type: 'session.ready' },
  { type: 'session.updated', session: { ...snapshot, busy: true, activeTurnId: 'turn-1' } },
  { type: 'session.closed' },
  { type: 'session.failed', error: { message: 'provider exited', code: 'provider_exit' } },
  { type: 'prompt.accepted', clientMessageId: 'm-1', result: 'turn', turnId: 'turn-1' },
  { type: 'prompt.failed', clientMessageId: 'm-2', error: { message: 'unknown', code: 'outcome_unknown' } },
  { type: 'turn.started', turnId: 'turn-1', origin: 'user' },
  { type: 'turn.ended', turnId: 'turn-1', state: 'canceled' },
  { type: 'turn.ended', turnId: 'turn-2', state: 'failed', error: { message: 'alpd stopped while this session was working', code: 'daemon_restarted' } },
  { type: 'mail', mail: { id: 'mail-1', kind: 'note', from: 'user', assignment: 'ses_child', body: 'xin chào' } },
  { type: 'assignment', assignment: { id: 'ses_child', agent: 'peer', mode: 'workspace-write', status: 'running', startedAt: ts, worktree: { branch: 'alp/peer', path: '/work/wt' } } },
  { type: 'question', question },
  { type: 'question.resolved', questionId: 'q_1', outcome: 'answered', answer: 'có' },
  { type: 'pin', pin },
  { type: 'unpin', pinId: 'pin_1', reason: 'session_ended' },
  { type: 'usage', usage: { contextWindowUsedTokens: 42000, contextWindowMaxTokens: 200000, inputTokens: 40000, cachedInputTokens: 36000, outputTokens: 2000, totalCostUsd: 0.1234 } },
];
const items = [
  { kind: 'user_message', id: 'user:m-1', text: 'Chào 👋', clientMessageId: 'm-1' },
  { kind: 'assistant_message', id: 'msg-1', text: 'Đã xong.' },
  { kind: 'notice', id: 'n-1', level: 'warning', text: 'Claude is paused' },
  { kind: 'compaction', id: 'c-1', status: 'completed', trigger: 'auto', preTokens: 180000, postTokens: 40000 },
  { kind: 'todo', id: 't-1', items: [{ id: 'bd-1', text: 'Viết test', status: 'in_progress' }] },
  { kind: 'tool_call', id: 'tc-1', callId: 'call-1', name: 'shell', status: 'completed', detail: { type: 'shell', command: 'npm test', cwd: '/work/project', output: 'ok', exitCode: 0 } },
  { kind: 'tool_call', id: 'tc-2', callId: 'call-2', name: 'alp_ask', status: 'failed', error: 'denied', detail: { type: 'unknown', input: { to: 'user' }, output: null } },
  { kind: 'tool_call', id: 'tc-3', callId: 'tc-3', name: 'Read', status: 'completed', detail: { type: 'read', filePath: '/work/project/src/a.ts', content: 'export const a = 1;\n', offset: 1, limit: 200 } },
  { kind: 'tool_call', id: 'tc-4', callId: 'tc-4', name: 'Edit', status: 'completed', detail: { type: 'edit', filePath: '/work/project/src/a.ts', oldString: 'a = 1', newString: 'a = 2', unifiedDiff: '@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n' } },
  { kind: 'tool_call', id: 'tc-5', callId: 'tc-5', name: 'Write', status: 'running', detail: { type: 'write', filePath: 'docs/ghi-chú.md', content: '# Ghi chú\n' } },
  { kind: 'tool_call', id: 'tc-6', callId: 'tc-6', name: 'Grep', status: 'completed', detail: { type: 'search', query: 'TODO', toolName: 'grep', content: 'src/a.ts:3: // TODO', filePaths: ['src/a.ts'], numFiles: 1, numMatches: 1, truncated: false } },
  { kind: 'tool_call', id: 'tc-7', callId: 'tc-7', name: 'web_search', status: 'completed', detail: { type: 'search', query: 'json-rpc 2.0', toolName: 'web_search', webResults: [{ title: 'JSON-RPC 2.0 Specification', url: 'https://www.jsonrpc.org/specification' }] } },
  { kind: 'tool_call', id: 'tc-8', callId: 'tc-8', name: 'WebFetch', status: 'failed', error: 'Request failed with status code 404', detail: { type: 'fetch', url: 'https://example.com/missing', prompt: 'Summarize', code: 404 } },
  { kind: 'tool_call', id: 'tc-9', callId: 'tc-9', name: 'Task', status: 'running', detail: { type: 'sub_agent', subAgentType: 'Explore', description: 'Find the parser', log: '' } },
  { kind: 'tool_call', id: 'tc-10', callId: 'tc-10', name: 'ExitPlanMode', status: 'completed', detail: { type: 'plan', text: '1. Đọc\n2. Sửa' } },
  { kind: 'tool_call', id: 'tc-11', callId: 'tc-11', name: 'Skill', status: 'completed', detail: { type: 'plain_text', label: 'smart-commits', text: 'Launching skill: smart-commits' } },
];
for (const event of events) add('envelope', `event ${event.type}${event.state ? ` ${event.state}` : ''}`, env(event));
for (const item of items) add('envelope', `item ${item.kind}${item.detail ? ` ${item.detail.type}${item.detail.toolName ? ` ${item.detail.toolName}` : ''}` : ''}`, env({ type: 'item', item }));
add('envelope', 'item user_message with images', env({ type: 'item', item: { kind: 'user_message', id: 'user:m-2', text: 'Xem ảnh', clientMessageId: 'm-2', images: 2 } }));
add('envelope', 'announcement without a cursor', { sessionId: 'ses_fixture', epoch: 'announce-2026', seq: 0, ts, event: { type: 'question', question } });
add('envelope', 'a future event type (receivers ignore it)', env({ type: 'tree.renamed', title: 'x' }));
add('envelope', 'a future item kind (receivers ignore it)', env({ type: 'item', item: { kind: 'image', id: 'img-1', url: 'x' } }));
add('envelope', 'a future tool-call detail type (receivers show it as unknown)', env({ type: 'item', item: { kind: 'tool_call', id: 'tc-12', callId: 'tc-12', name: 'Screenshot', status: 'completed', detail: { type: 'image', path: '/tmp/s.png' } } }));
add('envelope', 'unknown envelope properties', env({ type: 'session.ready' }, { trace: { span: 'abc' } }));
add('envelope', 'negative seq', env({ type: 'session.ready' }, { seq: -1 }), false);
add('envelope', 'cursor 0', env({ type: 'session.ready' }, { cursor: 0 }), false);
add('envelope', 'item event without its item', env({ type: 'item' }), false);
add('envelope', 'known item kind missing fields', env({ type: 'item', item: { kind: 'notice', id: 'n' } }), false);
add('envelope', 'edit detail without its filePath', env({ type: 'item', item: { kind: 'tool_call', id: 'tc-x', callId: 'tc-x', name: 'Edit', status: 'completed', detail: { type: 'edit', newString: 'x' } } }), false);
add('envelope', 'search detail with a non-string file path', env({ type: 'item', item: { kind: 'tool_call', id: 'tc-x', callId: 'tc-x', name: 'Glob', status: 'completed', detail: { type: 'search', query: '*.ts', filePaths: [1] } } }), false);
add('envelope', 'tool-call detail without a type', env({ type: 'item', item: { kind: 'tool_call', id: 'tc-x', callId: 'tc-x', name: 'Read', status: 'completed', detail: { filePath: 'a' } } }), false);
add('envelope', 'known event with a wrong enum', env({ type: 'turn.ended', turnId: 't', state: 'stopped' }), false);
add('envelope', 'usage before the runtime said its window', env({ type: 'usage', usage: { contextWindowUsedTokens: 1200 } }));
add('envelope', 'session.updated with usage', env({ type: 'session.updated', session: { ...snapshot, usage: { contextWindowUsedTokens: 42000, contextWindowMaxTokens: 200000 } } }));
add('envelope', 'usage event without its usage', env({ type: 'usage' }), false);
add('envelope', 'usage with negative tokens', env({ type: 'usage', usage: { contextWindowUsedTokens: -1 } }), false);
add('envelope', 'usage with a zero window', env({ type: 'usage', usage: { contextWindowMaxTokens: 0 } }), false);
add('envelope', 'usage with fractional tokens', env({ type: 'usage', usage: { outputTokens: 1.5 } }), false);
add('envelope', 'missing epoch', (({ epoch, ...rest }) => rest)(env({ type: 'session.ready' })), false);

// params and results of every method
const P = (method, value, valid = true, name = 'params') => add('params', `${method} ${name}`, value, valid, method);
const R = (method, value, valid = true, name = 'result') => add('result', `${method} ${name}`, value, valid, method);
P('daemon.hello', { protocolVersion: 1, client: { name: 'paseo', version: '0.10.0' } });
P('daemon.hello', { protocolVersion: 1 }, true, 'without client');
P('daemon.hello', { protocolVersion: 1, client: 'paseo' }, false, 'with a string client');
R('daemon.hello', { protocolVersion: 1, daemonVersion: '0.10.0', pid: 42, capabilities: ['attach.after', 'prompt.receipts', 'extension.methods'] });
R('daemon.hello', { protocolVersion: 1, daemonVersion: '0.9.5', pid: 42 }, true, 'from a daemon before capabilities');
R('daemon.hello', { protocolVersion: 1, daemonVersion: '0.10.0', pid: 42, hostname: 'build-host', capabilities: [] }, true, 'with the host name');
R('daemon.hello', { protocolVersion: 1, hostname: 42 }, false, 'with a numeric hostname');
P('daemon.status', {});
R('daemon.status', { pid: 42, startedAt: ts, version: '0.10.0', protocolVersion: 1, sessions: 1, questions: 0, previousExit: { kind: 'clean' }, persistence: { failing: 0 }, health: { live: true, ready: true, checks: [{ id: 'accepting', ok: true }] } });
R('daemon.status', { pid: 42, startedAt: ts, version: '0.10.0', protocolVersion: 1, sessions: 1, questions: 0 }, false, 'result without health');
P('daemon.shutdown', {}); R('daemon.shutdown', {});
P('daemon.pause', { runtime: 'claude', now: true, reason: 'tối nay' });
P('daemon.pause', { runtime: 'gemini' }, false, 'with an unknown runtime');
R('daemon.pause', pauses);
P('daemon.resume', { runtime: 'codex' }); R('daemon.resume', { runtimes: {}, parked: [] });
P('daemon.pauses', {}); R('daemon.pauses', { all: { since: ts, by: 'the user', reason: 'paused by the user' }, runtimes: {}, parked: [] });
P('daemon.usage', { refresh: true }); R('daemon.usage', { providers: [{ runtime: 'codex', pause: null, parked: 0 }] });
P('catalog.get', {}); R('catalog.get', { models: [{ id: 'codex:gpt-6.1-sol', label: 'Codex · GPT-6.1-Sol' }], modes: [{ id: 'read-only', label: 'Read only' }], thinkingOptions: [{ id: 'low', label: 'low' }], defaultModel: 'codex:gpt-6.1-sol' });
P('assignment.recall', { assignmentId: 'a_1', question: 'Bạn đã sửa gì?' });
P('assignment.recall', { assignmentId: 'a_1' }, false, 'without a question');
R('assignment.recall', { assignmentId: 'a_1', agent: 'peer', taskId: 'bd-1', finishedAt: ts, answer: 'Đã sửa server.ts' });
P('board.list', { projectRoot: '/work/project' }); P('board.list', {}, false, 'without projectRoot');
R('board.list', { pins: [pin] });
P('question.list', { projectRoot: '/work/project' }); R('question.list', { questions: [question] });
P('question.watch', { projectRoot: '/work/project' }); P('question.watch', {}, true, 'every tree'); R('question.watch', { questions: [question] });
P('question.watch', { projectRoot: 7 }, false, 'with a numeric projectRoot');
P('question.watch', { projectRoot: '/work/project', turns: true }, true, 'with turns');
P('question.watch', { turns: 'yes' }, false, 'with a string turns');
P('workspace.files.search', { projectRoot: '/work/project', query: 'server ts', limit: 30 });
P('workspace.files.search', { projectRoot: '/work/project' }, true, 'without a query');
P('workspace.files.search', { query: 'server' }, false, 'without projectRoot');
P('workspace.files.search', { projectRoot: '/work/project', limit: 101 }, false, 'with a limit over 100');
P('workspace.files.search', { projectRoot: '/work/project', query: 'x'.repeat(201) }, false, 'with a query over 200 characters');
R('workspace.files.search', { files: [{ path: 'src/server.ts' }, { path: 'docs/sửa lỗi.md' }], truncated: true });
R('workspace.files.search', { files: [{ path: '' }] }, false, 'result with an empty path');
P('workspace.files.list', { projectRoot: '/work/project' }, true, 'the root');
P('workspace.files.list', { projectRoot: '/work/project', path: 'src', includeIgnored: true });
P('workspace.files.list', { path: 'src' }, false, 'without projectRoot');
P('workspace.files.list', { projectRoot: '/work/project', path: '' }, false, 'with an empty path');
P('workspace.files.list', { projectRoot: '/work/project', includeIgnored: 'yes' }, false, 'with a string includeIgnored');
R('workspace.files.list', { entries: [{ name: 'src', path: 'src', kind: 'directory', modifiedAt: ts }, { name: 'sửa lỗi.md', path: 'sửa lỗi.md', kind: 'file', size: 12, modifiedAt: ts }], truncated: true });
R('workspace.files.list', { entries: [{ name: 'x', path: 'x', kind: 'link' }] }, false, 'result with a link entry');
P('workspace.files.read', { projectRoot: '/work/project', path: 'src/server.ts' });
P('workspace.files.read', { projectRoot: '/work/project', path: 'dist/out.js', includeIgnored: true }, true, 'an ignored file');
P('workspace.files.read', { projectRoot: '/work/project' }, false, 'without path');
P('workspace.files.read', { projectRoot: '/work/project', path: 'x'.repeat(4097) }, false, 'with a path over 4096 characters');
R('workspace.files.read', { path: 'src/server.ts', content: 'export {};\n', size: 11, modifiedAt: ts });
R('workspace.files.read', { path: 'big.txt', content: '', size: 1048577 }, false, 'result over 1 MiB');
P('question.answer', { questionId: 'q_1', text: 'có' }); P('question.answer', { questionId: 'q_1', dismiss: true, reason: 'không cần' }, true, 'dismissal');
R('question.answer', { questionId: 'q_1' });
P('session.create', { sessionId: 'ses_fixture', spec: { cwd: '/work/project', model: 'codex:gpt-6.1-sol', persist: true, mcpServers: { docs: { type: 'http', url: 'https://example.invalid/mcp' } } }, history: 'replay', delegation: false });
P('session.create', { sessionId: 'has space', spec: { cwd: '/work/project' } }, false, 'with an invalid session id');
P('session.create', { spec: {} }, false, 'without spec.cwd');
R('session.create', { session: snapshot, attached: false, durable: true });
R('session.create', { session: snapshot, attached: false, resumed: true, durable: true }, true, 'result of a resume');
P('session.preview', { spec: { cwd: '/work/project', workflow: 'cafe' } });
R('session.preview', { preview: { teams: [{ id: 'pho', label: 'Phở' }, { id: 'cafe', label: 'Cafe', description: 'Hai agent' }], team: 'cafe', teamLabel: 'Cafe', agent: 'main', runtime: 'claude', model: 'claude-opus-5-5', mode: 'full-access', thinking: 'high' } });
P('session.attach', { sessionId: 'ses_fixture', after: 12 });
P('session.attach', { sessionId: 'ses_fixture', after: -1 }, false, 'with a negative cursor');
R('session.attach', { session: summary, cursor: 40 });
R('session.attach', { session: summary, cursor: 40, reset: true }, true, 'result of a reset');
R('session.attach', { session: summary, cursor: 40, reset: false }, false, 'result with reset false');
P('session.release', { sessionId: 'ses_fixture' }); R('session.release', { closed: true });
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-1', delivery: 'steer', content: [{ type: 'text', text: 'Dừng lại 🛑' }] });
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-1', content: 'text' }, false, 'with string content');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-2', content: [{ type: 'text', text: 'Xem ảnh' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'ảnh.png' }] }, true, 'with an inline image');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-2', content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', path: '/etc/passwd' }] }, false, 'with an image path');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-2', content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', url: 'file:///etc/passwd' }] }, false, 'with an image url');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-2', content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }] }, false, 'with an svg image');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-2', content: [{ type: 'image', mimeType: 'image/png', data: 'not base64!' }] }, false, 'with image data that is not base64');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-2', content: [{ type: 'image', mimeType: 'image/png' }] }, false, 'with an image without data');
P('session.prompt', { sessionId: 'ses_fixture', clientMessageId: 'm-1', delivery: 'later', content: [] }, false, 'with an unknown delivery');
R('session.prompt', { outcome: 'accepted', durable: true });
R('session.prompt', { outcome: 'accepted', duplicate: true, durable: true }, true, 'result of a repeat');
R('session.prompt', { outcome: 'failed', error: { message: 'Session is busy' }, durable: true }, true, 'result of a refused prompt');
R('session.prompt', {}, true, 'result without receipts');
P('session.interrupt', { sessionId: 'ses_fixture' }); R('session.interrupt', {});
P('session.configure', { sessionId: 'ses_fixture', mode: 'read-only' }); P('session.configure', { sessionId: 'ses_fixture' }, true, 'without mode');
R('session.configure', { session: snapshot });
P('session.close', { sessionId: 'ses_fixture' }); R('session.close', {});
P('session.rename', { sessionId: 'ses_fixture', title: '😀'.repeat(200) }, true, 'with 200 astral characters');
P('session.rename', { sessionId: 'ses_fixture', title: '😀'.repeat(201) }, false, 'with 201 characters');
P('session.rename', { sessionId: 'ses_fixture', title: '   ' }, false, 'with a blank title');
R('session.rename', { session: summary });
P('session.archive', { sessionId: 'ses_fixture', archived: false }); R('session.archive', { session: { ...summary, status: 'closed', archived: true } });
P('session.get', { sessionId: 'ses_fixture' }); P('session.get', { sessionId: null }, false, 'with a null session id');
R('session.get', { session: { ...summary, status: 'error', lastError: { code: 'daemon_restarted', message: 'alpd stopped' } } });
R('session.get', { session: { ...summary, status: 'paused' } }, false, 'result with an unknown status');
R('session.get', { session: { ...summary, promptImages: true } }, true, 'result of a session that takes images');
P('session.list', { projectRoot: '/work/project', rootsOnly: true, includeClosed: true, includeArchived: false });
P('session.list', { projectRoot: null }, false, 'with a null projectRoot');
R('session.list', { sessions: [summary] });
P('session.list', { projectRoot: '/work/project', rootsOnly: true, includeArchived: true, limit: 200, cursor: 'eyJrIjpbMF19', query: 'sửa lỗi' }, true, 'a page with a query');
P('session.list', { limit: 0 }, false, 'with a zero limit');
P('session.list', { projectRoots: ['/work/project', '/private/work/project'], limit: 50 }, true, 'of several projects');
P('session.list', { projectRoots: [] }, false, 'with no projects');
P('session.list', { limit: 2.5 }, false, 'with a fractional limit');
P('session.list', { cursor: '' }, false, 'with an empty cursor');
R('session.list', { sessions: [summary], nextCursor: 'eyJrIjpbMF19' }, true, 'a page with more after it');
P('session.status', { sessionId: 'ses_fixture' });
R('session.status', { status: { rootId: 'ses_fixture', sessions: [{ ...snapshot, state: 'waiting_user', idleMs: 1200, workdir: '/work/project', unreadMail: 0 }], assignments: [{ id: 'ses_child', agent: 'peer', mode: 'workspace-write', status: 'running', startedAt: ts, requester: 'ses_fixture', isolation: 'shared', idleMs: 5 }], questions: [question], worktrees: [], leases: [{ checkout: '/work/project', assignmentId: 'ses_child', agent: 'peer' }], claims: [pin] } });
P('session.message', { sessionId: 'ses_fixture', text: 'Ghi chú' }); R('session.message', {});
P('session.log', { sessionId: 'ses_fixture' }); R('session.log', { rootId: 'ses_fixture', entries: [{ ts, event: 'assignment.finished', assignmentId: 'a_1' }] });
P('extension.register', { method: 'web.pairing' }); R('extension.register', { registered: 'web.pairing' });
P('extension.unregister', { method: 'web.pairing' }); R('extension.unregister', { unregistered: 'web.pairing' });

// project, task, library and settings methods (capabilities team, task, library, settings.language)
const row = { id: 't-a3f8', title: 'Viết test 😀', type: 'task', priority: 2, status: 'open', rev: 3, ready: true, approvals: [{ gate: 'g1', note: 'Duyệt?' }], labels: ['rpc'], createdAt: ts, updatedAt: ts };
P('team.list', { projectRoot: '/work/project' }); P('team.list', {}, true, 'without a project');
P('team.list', { projectRoot: '' }, false, 'with an empty projectRoot');
R('team.list', { projectRoot: '/work/project', teams: [{ id: 'pho', label: 'Phở', source: 'builtin' }, { id: 'mine', source: 'library', error: 'agent x is missing' }] });
P('task.list', { projectRoot: '/work/project' }); P('task.list', {}, false, 'without projectRoot');
R('task.list', { projectRoot: '/work/project', tasks: [row, { ...row, id: 't-a3f8.1', status: 'closed', rev: 0, ready: false, closed: { reason: 'done', at: ts }, progress: { done: 1, total: 2 } }], unreadable: [{ file: '.alp/tasks/t-bad.json', error: 'not JSON' }], revision: 'abc' });
R('task.list', { projectRoot: '/work/project', tasks: [{ ...row, status: 'blocked' }], unreadable: [], revision: 'x' }, false, 'result with an unknown status');
P('task.create', { projectRoot: '/work/project', title: 'Sửa lỗi', priority: 0, requestId: 'req-1' });
P('task.create', { projectRoot: '/work/project', title: ' ' }, false, 'with a blank title');
P('task.create', { projectRoot: '/work/project', title: 'x', priority: 5 }, false, 'with priority 5');
R('task.create', { id: 't-a3f8' }); R('task.create', { id: 't-a3f8', duplicate: true }, true, 'result of a repeat');
P('task.update', { projectRoot: '/work/project', id: 't-a3f8', action: 'close', note: 'Xong', ifRev: 3 });
P('task.update', { projectRoot: '/work/project', id: 't-a3f8', action: 'approve' }, false, 'with action approve (that is task.gate.resolve)');
P('task.update', { projectRoot: '/work/project', id: 'bd-1', action: 'close' }, false, 'with an id that is not a task id');
R('task.update', { id: 't-a3f8', status: 'closed', rev: 4, landed: 'Epic t-a3f8 landed' });
P('task.gate.resolve', { projectRoot: '/work/project', id: 't-a3f8', gate: 'g1', note: 'OK' });
R('task.gate.resolve', { id: 't-a3f8', status: 'open', rev: 5 });
P('library.list', { kind: 'agents', projectRoot: '/work/project' }); P('library.list', { kind: 'plugins' }, false, 'with an unknown kind');
R('library.list', { projectRoot: null, entries: [{ name: 'main', source: 'builtin' }, { name: 'reviewer', source: 'project', overrides: 'library', description: 'Đọc lại', usedBy: ['team pho'] }] });
P('library.get', { kind: 'mcp', name: 'docs', projectRoot: '/work/project', scope: 'project' });
P('library.get', { kind: 'mcp', name: '..' }, false, 'with the name ..');
P('library.get', { kind: 'mcp', name: 'a/b' }, false, 'with a slash in the name');
R('library.get', { kind: 'mcp', name: 'docs', source: 'library', content: { server: { url: 'https://example.invalid/mcp', headers: { Authorization: { $secret: 'keep' } } } }, revision: 'r-1', usedBy: ['agent main'], secrets: ['/server/headers/Authorization'] });
R('library.get', { kind: 'agents', name: 'main', source: 'builtin', content: { instructions: '…' }, revision: null, usedBy: [], librarySkills: ['tdd'] }, true, 'result of a built-in agent');
P('library.save', { kind: 'providers', name: 'gemini', scope: 'library', content: { provider: { kind: 'acp', command: 'gemini', env: { GEMINI_API_KEY: { $secret: 'keep' } } } }, revision: 'r-1' });
P('library.save', { kind: 'teams', name: 'mine', scope: 'project', projectRoot: '/work/project', content: { team: {} }, revision: null, sync: 'known-projects' }, true, 'creating a team with sync');
P('library.save', { kind: 'skills', name: 'tdd', scope: 'everywhere', content: {} }, false, 'with an unknown scope');
R('library.save', { revision: 'r-2', syncedProjects: 2, syncErrors: [] });
P('library.delete', { kind: 'skills', name: 'tdd', scope: 'library', revision: 'r-2' }); R('library.delete', { removed: true, now: 'builtin' });
P('library.duplicate', { kind: 'agents', from: 'main', to: 'main-2', scope: 'library' }); R('library.duplicate', { revision: 'r-3' });
P('library.rename', { kind: 'agents', from: 'main-2', to: 'helper', scope: 'project', projectRoot: '/work/project' }); R('library.rename', { revision: 'r-4' });
P('library.skills.set', { agent: 'main', skills: ['tdd'] }); R('library.skills.set', { skills: ['tdd'] });
P('library.models', {}); R('library.models', { models: [{ id: 'codex:gpt-6.1-sol', label: 'codex · GPT-6.1-Sol', efforts: ['low', 'high'], effort: 'low' }, { id: 'acp:gemini', label: 'Gemini · Provider default', efforts: [] }] });
P('settings.language.get', {}); R('settings.language.get', { language: null, applies: 'Vietnamese', default: 'Vietnamese' });
P('settings.language.set', { language: 'English' }); P('settings.language.set', { language: null }, true, 'clearing the language');
P('settings.language.set', {}, false, 'without language');
R('settings.language.set', { language: 'English', applies: 'English', default: 'Vietnamese' });

P('daemon.hello', { protocolVersion: '1' }, false, 'with a string protocolVersion');
P('session.list', { includeClosed: 'yes' }, false, 'with a string flag');
P('extension.register', {}, false, 'without method');
P('question.answer', { text: 'có' }, false, 'without questionId');
R('session.prompt', { outcome: 'unknown' }, false, 'result with outcome unknown (that is an error, never a result)');
add('envelope', 'fractional cursor', env({ type: 'session.ready' }, { cursor: 1.5 }), false);
for (const fixture of cases) if (['a future event type (receivers ignore it)', 'a future item kind (receivers ignore it)', 'a future tool-call detail type (receivers show it as unknown)', 'unknown envelope properties'].includes(fixture.name)) fixture.projection = false;
// Cases added after the original v1 corpus. Keep their order and explicit metadata
// stable so regeneration preserves the published golden file byte for byte.
cases.push({"name":"schedule.create params","check":"params","method":"schedule.create","valid":true,"value":{"projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","dueAt":"2026-10-20T10:00:00.000Z","prompt":"Check the provider quota and continue."}});
cases.push({"name":"schedule.create without a prompt","check":"params","method":"schedule.create","valid":false,"value":{"projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","dueAt":"2026-10-20T10:00:00.000Z"}});
cases.push({"name":"schedule.create with a dueAt that is not a time","check":"params","method":"schedule.create","valid":false,"value":{"projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","dueAt":"tomorrow","prompt":"Check the provider quota and continue."}});
cases.push({"name":"schedule.create result","check":"result","method":"schedule.create","valid":true,"value":{"job":{"id":"sch_0123456789abcdef","projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","prompt":"Check the provider quota and continue.","dueAt":"2026-10-20T10:00:00.000Z","status":"pending","attempts":0,"createdAt":"2026-10-20T09:59:00.000Z","updatedAt":"2026-10-20T09:59:00.000Z"}}});
cases.push({"name":"schedule.list params","check":"params","method":"schedule.list","valid":true,"value":{"projectRoot":"/work/project"}});
cases.push({"name":"schedule.list with a status","check":"params","method":"schedule.list","valid":true,"value":{"projectRoot":"/work/project","status":"pending"}});
cases.push({"name":"schedule.list with an unknown status","check":"params","method":"schedule.list","valid":false,"value":{"projectRoot":"/work/project","status":"unknown"}});
cases.push({"name":"schedule.list without a project","check":"params","method":"schedule.list","valid":false,"value":{"status":"pending"}});
cases.push({"name":"schedule.list result","check":"result","method":"schedule.list","valid":true,"value":{"jobs":[{"id":"sch_0123456789abcdef","projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","prompt":"Check the provider quota and continue.","dueAt":"2026-10-20T10:00:00.000Z","status":"pending","attempts":0,"createdAt":"2026-10-20T09:59:00.000Z","updatedAt":"2026-10-20T09:59:00.000Z"}]}});
cases.push({"name":"schedule.get params","check":"params","method":"schedule.get","valid":true,"value":{"id":"sch_0123456789abcdef","projectRoot":"/work/project"}});
cases.push({"name":"schedule.get with an id that is not a job","check":"params","method":"schedule.get","valid":false,"value":{"id":"nope","projectRoot":"/work/project"}});
cases.push({"name":"schedule.get without a project","check":"params","method":"schedule.get","valid":false,"value":{"id":"sch_0123456789abcdef"}});
cases.push({"name":"schedule.get result","check":"result","method":"schedule.get","valid":true,"value":{"job":{"id":"sch_0123456789abcdef","projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","prompt":"Check the provider quota and continue.","dueAt":"2026-10-20T10:00:00.000Z","status":"delivered","attempts":1,"createdAt":"2026-10-20T09:59:00.000Z","updatedAt":"2026-10-20T10:00:03.000Z","attemptedAt":"2026-10-20T10:00:03.000Z","deliveredAt":"2026-10-20T10:00:03.000Z","lateByMs":3000}}});
cases.push({"name":"schedule.cancel params","check":"params","method":"schedule.cancel","valid":true,"value":{"id":"sch_0123456789abcdef","projectRoot":"/work/project"}});
cases.push({"name":"schedule.cancel without a project","check":"params","method":"schedule.cancel","valid":false,"value":{"id":"sch_0123456789abcdef"}});
cases.push({"name":"schedule.cancel result","check":"result","method":"schedule.cancel","valid":true,"value":{"job":{"id":"sch_0123456789abcdef","projectRoot":"/work/project","sessionId":"ses_0123456789abcdef","prompt":"Check the provider quota and continue.","dueAt":"2026-10-20T10:00:00.000Z","status":"cancelled","attempts":0,"createdAt":"2026-10-20T09:59:00.000Z","updatedAt":"2026-10-20T09:59:30.000Z","cancelledAt":"2026-10-20T09:59:30.000Z"}}});
cases.push({"name":"event attention","check":"envelope","valid":true,"value":{"sessionId":"ses_fixture","epoch":"attention-1","seq":0,"ts":"2026-10-15T00:00:00.000Z","event":{"type":"attention","attention":{"reason":"error","at":"2026-10-15T00:00:00.000Z","turnId":"turn-2","message":"Hết hạn mức"}}}});
cases.push({"name":"event attention cleared","check":"envelope","valid":true,"value":{"sessionId":"ses_fixture","epoch":"attention-1","seq":0,"ts":"2026-10-15T00:00:00.000Z","event":{"type":"attention"}}});
cases.push({"name":"event attention with an unknown reason","check":"envelope","valid":false,"value":{"sessionId":"ses_fixture","epoch":"attention-1","seq":0,"ts":"2026-10-15T00:00:00.000Z","event":{"type":"attention","attention":{"reason":"done","at":"2026-10-15T00:00:00.000Z"}}}});
cases.push({"name":"item user_message with origin","check":"envelope","valid":true,"value":{"sessionId":"ses_fixture","epoch":"epoch-1","seq":3,"cursor":12,"ts":"2026-10-15T00:00:00.000Z","event":{"type":"item","item":{"kind":"user_message","id":"user:alp-wake-1","text":"ALP mail from other agents.","clientMessageId":"alp-wake-1","origin":"wake"}}}});
cases.push({"name":"item user_message with an unknown origin","check":"envelope","valid":false,"value":{"sessionId":"ses_fixture","epoch":"epoch-1","seq":3,"cursor":12,"ts":"2026-10-15T00:00:00.000Z","event":{"type":"item","item":{"kind":"user_message","id":"user:m-3","text":"x","origin":"robot"}}}});
cases.push({"name":"question.watch with attention","check":"params","method":"question.watch","valid":true,"value":{"projectRoot":"/work/project","turns":true,"attention":true}});
cases.push({"name":"question.watch with a numeric attention","check":"params","method":"question.watch","valid":false,"value":{"attention":1}});
cases.push({"name":"question.watch with attention","check":"result","method":"question.watch","valid":true,"value":{"questions":[],"attention":[{"sessionId":"ses_fixture","attention":{"reason":"finished","at":"2026-10-15T00:00:00.000Z","turnId":"turn-1"}}]}});
cases.push({"name":"question.watch with an unknown attention reason","check":"result","method":"question.watch","valid":false,"value":{"questions":[],"attention":[{"sessionId":"ses_fixture","attention":{"reason":"done","at":"2026-10-15T00:00:00.000Z"}}]}});
cases.push({"name":"session.attention.clear params","check":"params","method":"session.attention.clear","valid":true,"value":{"sessionId":"ses_fixture"}});
cases.push({"name":"session.attention.clear with at","check":"params","method":"session.attention.clear","valid":true,"value":{"sessionId":"ses_fixture","at":"2026-10-15T00:00:00.000Z"}});
cases.push({"name":"session.attention.clear without sessionId","check":"params","method":"session.attention.clear","valid":false,"value":{}});
cases.push({"name":"session.attention.clear result","check":"result","method":"session.attention.clear","valid":true,"value":{"cleared":true}});
cases.push({"name":"session.attention.clear without cleared","check":"result","method":"session.attention.clear","valid":false,"value":{}});
cases.push({"name":"history params","check":"params","method":"session.history","valid":true,"value":{"sessionId":"r","limit":200}});
cases.push({"name":"history oversized result","check":"result","method":"session.history","valid":true,"value":{"generation":"g","items":[{"cursor":2,"oversized":{"bytes":800000}}],"hasOlder":false,"tipCursor":2}});
cases.push({"name":"history limit refuses unbounded page","check":"params","method":"session.history","valid":false,"value":{"sessionId":"r","limit":501}});
cases.push({"name":"generation-bound attach","check":"params","method":"session.attach","valid":true,"value":{"sessionId":"r","after":0,"generation":"g"}});
cases.push({"name":"project.list params","check":"params","method":"project.list","valid":true,"value":{}});
cases.push({"name":"project.list result","check":"result","method":"project.list","valid":true,"value":{"projects":[{"id":"prj_0000000000000001","root":"/workspace","addedAt":"2026-10-20T00:00:00Z"}],"total":1,"revision":1,"nextCursor":null}});
cases.push({"name":"workspace.list params","check":"params","method":"workspace.list","valid":true,"value":{}});
cases.push({"name":"workspace.list result","check":"result","method":"workspace.list","valid":true,"value":{"workspaces":[{"id":"wks_0000000000000001","projectId":"prj_0000000000000001","directory":"/workspace","labels":[],"createdAt":"2026-10-20T00:00:00Z"}],"total":1,"revision":1,"nextCursor":null}});
cases.push({"name":"workspace.get params","check":"params","method":"workspace.get","valid":true,"value":{"workspaceId":"wks_0000000000000001"}});
cases.push({"name":"workspace.get result","check":"result","method":"workspace.get","valid":true,"value":{"workspace":{"id":"wks_0000000000000001","projectId":"prj_0000000000000001","directory":"/workspace","labels":[],"createdAt":"2026-10-20T00:00:00Z"},"revision":1}});
cases.push({"name":"project.register params","check":"params","method":"project.register","valid":true,"value":{"directory":"/workspace","requestId":"add","ifRevision":0}});
cases.push({"name":"project.register result","check":"result","method":"project.register","valid":true,"value":{"project":{"id":"prj_0000000000000001","root":"/workspace","addedAt":"2026-10-20T00:00:00Z"},"revision":1}});
cases.push({"name":"project.remove params","check":"params","method":"project.remove","valid":true,"value":{"projectId":"prj_0000000000000001","requestId":"remove","ifRevision":1}});
cases.push({"name":"project.remove result","check":"result","method":"project.remove","valid":true,"value":{"project":{"id":"prj_0000000000000001","root":"/workspace","addedAt":"2026-10-20T00:00:00Z"},"revision":2}});
cases.push({"name":"workspace.update params","check":"params","method":"workspace.update","valid":true,"value":{"workspaceId":"wks_0000000000000001","pinned":true,"requestId":"pin","ifRevision":1}});
cases.push({"name":"workspace.update result","check":"result","method":"workspace.update","valid":true,"value":{"workspace":{"id":"wks_0000000000000001","projectId":"prj_0000000000000001","directory":"/workspace","labels":[],"createdAt":"2026-10-20T00:00:00Z","pinnedAt":"2026-10-20T00:00:00Z"},"revision":2}});
cases.push({"name":"registry.owner params","check":"params","method":"registry.owner","valid":true,"value":{}});
cases.push({"name":"registry.owner result","check":"result","method":"registry.owner","valid":true,"value":{"registry":{}}});
cases.push({"name":"workspaceId resolves host cwd","check":"params","method":"session.create","valid":true,"value":{"workspaceId":"wks_0000000000000001","spec":{"persist":true}}});
cases.push({"name":"registry.worktree params","check":"params","method":"registry.worktree","valid":true,"value":{}});
cases.push({"name":"registry.worktree result","check":"result","method":"registry.worktree","valid":true,"value":{"mappings":[],"workspaces":[]}});
cases.push({"name":"workspace.worktree.options params","check":"params","method":"workspace.worktree.options","valid":true,"value":{"workspaceId":"wks_0000000000000001"}});
cases.push({"name":"workspace.worktree.options result","check":"result","method":"workspace.worktree.options","valid":true,"value":{"mappingIds":["approved"]}});
cases.push({"name":"workspace.worktree.create params","check":"params","method":"workspace.worktree.create","valid":true,"value":{"workspaceId":"wks_0000000000000001","mappingId":"approved","requestId":"create","ifRevision":1}});
cases.push({"name":"workspace.worktree.create result","check":"result","method":"workspace.worktree.create","valid":true,"value":{"workspace":{"id":"wks_0000000000000002","projectId":"prj_0000000000000001","directory":"/managed/wks_0000000000000002","labels":[],"createdAt":"2026-10-21T00:00:00Z","managedWorktree":true,"branch":"alp/workspace/wks_0000000000000002"},"revision":2}});
cases.push({"name":"workspace.worktree.remove params","check":"params","method":"workspace.worktree.remove","valid":true,"value":{"workspaceId":"wks_0000000000000002","requestId":"remove","ifRevision":2}});
cases.push({"name":"workspace.worktree.remove result","check":"result","method":"workspace.worktree.remove","valid":true,"value":{"workspace":{"id":"wks_0000000000000002","projectId":"prj_0000000000000001","directory":"/managed/wks_0000000000000002","labels":[],"createdAt":"2026-10-21T00:00:00Z","managedWorktree":true,"branch":"alp/workspace/wks_0000000000000002"},"revision":3,"filesRemoved":true,"branchRetained":true}});
cases.push({"name":"worktree create rejects arbitrary destination","check":"params","method":"workspace.worktree.create","valid":false,"value":{"workspaceId":"wks_0000000000000001","mappingId":"approved","requestId":"create","ifRevision":1,"directory":"/outside"}});
cases.push({"name":"workspace.git.status params","check":"params","method":"workspace.git.status","valid":true,"value":{"workspaceId":"wks_0123456789abcdef"}});
cases.push({"name":"workspace.git.status without workspaceId","check":"params","method":"workspace.git.status","valid":false,"value":{}});
cases.push({"name":"workspace.git.status with a host path","check":"params","method":"workspace.git.status","valid":false,"value":{"workspaceId":"wks_0123456789abcdef","projectRoot":"/work/project"}});
cases.push({"name":"workspace.git.status result","check":"result","method":"workspace.git.status","valid":true,"value":{"state":"repository","branch":"feature/x","detached":false,"head":"0123456789abcdef0123456789abcdef01234567","upstream":{"ref":"origin/feature/x","ahead":1,"behind":0},"baseRef":"main","aheadBehind":{"ahead":2,"behind":1},"hasRemote":true,"remoteUrl":"https://github.com/example/project.git","dirty":true,"files":[{"path":"src/a.ts","change":"modified","staged":false,"unstaged":true},{"path":"src/b.ts","oldPath":"src/old-b.ts","change":"renamed","staged":true,"unstaged":false},{"path":"notes.txt","change":"untracked","staged":false,"unstaged":true}],"hiddenCount":1,"truncated":false,"snapshot":"s1.abc"}});
cases.push({"name":"workspace.git.status detached HEAD","check":"result","method":"workspace.git.status","valid":true,"value":{"state":"repository","branch":null,"detached":true,"head":"0123456789abcdef0123456789abcdef01234567","upstream":null,"baseRef":"main","aheadBehind":null,"hasRemote":false,"remoteUrl":null,"dirty":false,"files":[],"hiddenCount":0,"truncated":false,"snapshot":"s1.def"}});
cases.push({"name":"workspace.git.status not a repository","check":"result","method":"workspace.git.status","valid":true,"value":{"state":"not_repository","branch":null,"detached":false,"head":null,"upstream":null,"baseRef":null,"aheadBehind":null,"hasRemote":false,"remoteUrl":null,"dirty":false,"files":[],"hiddenCount":0,"truncated":false,"snapshot":""}});
cases.push({"name":"workspace.git.status with a repository root","check":"result","method":"workspace.git.status","valid":false,"value":{"state":"repository","repoRoot":"/work/project","branch":"main","detached":false,"head":null,"upstream":null,"baseRef":null,"aheadBehind":null,"hasRemote":false,"remoteUrl":null,"dirty":false,"files":[],"hiddenCount":0,"truncated":false,"snapshot":""}});
cases.push({"name":"workspace.git.diff params","check":"params","method":"workspace.git.diff","valid":true,"value":{"workspaceId":"wks_0123456789abcdef","compare":{"mode":"uncommitted"}}});
cases.push({"name":"workspace.git.diff one file against a base, next page","check":"params","method":"workspace.git.diff","valid":true,"value":{"workspaceId":"wks_0123456789abcdef","compare":{"mode":"base","baseRef":"main","ignoreWhitespace":true},"path":"src/a.ts","cursor":"c1.abc"}});
cases.push({"name":"workspace.git.diff with an arbitrary revision range","check":"params","method":"workspace.git.diff","valid":false,"value":{"workspaceId":"wks_0123456789abcdef","compare":{"mode":"range","from":"HEAD~3"}}});
cases.push({"name":"workspace.git.diff with extra git arguments","check":"params","method":"workspace.git.diff","valid":false,"value":{"workspaceId":"wks_0123456789abcdef","compare":{"mode":"uncommitted","args":["--ext-diff"]}}});
cases.push({"name":"workspace.git.diff without compare","check":"params","method":"workspace.git.diff","valid":false,"value":{"workspaceId":"wks_0123456789abcdef"}});
cases.push({"name":"workspace.git.diff result","check":"result","method":"workspace.git.diff","valid":true,"value":{"compare":{"mode":"uncommitted","ignoreWhitespace":false},"snapshot":"s1.abc","files":[{"path":"src/a.ts","change":"modified","kind":"text","additions":1,"deletions":1,"hunks":[{"oldStart":1,"oldCount":2,"newStart":1,"newCount":2,"context":"function main()","lines":[{"type":"context","content":"const a = 1;"},{"type":"remove","content":"const b = 2;"},{"type":"add","content":"const b = 3;","noNewline":true}]}]},{"path":"logo.png","change":"added","kind":"binary","additions":0,"deletions":0,"hunks":[]},{"path":"src/new.ts","oldPath":"src/old.ts","change":"renamed","kind":"too_large","additions":0,"deletions":0,"hunks":[]}],"hiddenCount":1,"truncated":true,"nextCursor":"c1.def"}});
cases.push({"name":"workspace.git.diff empty result","check":"result","method":"workspace.git.diff","valid":true,"value":{"compare":{"mode":"base","baseRef":"main","ignoreWhitespace":true},"snapshot":"s1.abc","files":[],"hiddenCount":0,"truncated":false}});
cases.push({"name":"workspace.git.diff result with a raw patch","check":"result","method":"workspace.git.diff","valid":false,"value":{"compare":{"mode":"uncommitted","ignoreWhitespace":false},"snapshot":"s1.abc","files":[{"path":"src/a.ts","change":"modified","kind":"text","additions":0,"deletions":0,"hunks":[],"patch":"diff --git a/src/a.ts b/src/a.ts"}],"hiddenCount":0,"truncated":false}});
cases.push({"name":"attachment.begin params","check":"params","method":"attachment.begin","valid":true,"value":{"sessionId":"ses_1","name":"report.pdf","size":1024,"mimeType":"application/pdf","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","requestId":"req-1"}});
cases.push({"name":"attachment.begin params from a gateway with principal context","check":"params","method":"attachment.begin","valid":true,"value":{"sessionId":"ses_1","name":"empty.txt","size":0,"mimeType":"text/plain","requestId":"req-2","principalId":"abcdef0123456789","principalEpoch":"0123456789abcdef0123456789abcdef","authorizedRoots":["/work/project"]}});
cases.push({"name":"attachment.begin params naming a host path","check":"params","method":"attachment.begin","valid":false,"value":{"sessionId":"ses_1","name":"report.pdf","size":1024,"mimeType":"application/pdf","requestId":"req-1","path":"/etc/passwd"}});
cases.push({"name":"attachment.begin params with a URL instead of bytes","check":"params","method":"attachment.begin","valid":false,"value":{"sessionId":"ses_1","name":"report.pdf","size":1024,"mimeType":"application/pdf","requestId":"req-1","url":"https://example.com/report.pdf"}});
cases.push({"name":"attachment.begin params with a negative size","check":"params","method":"attachment.begin","valid":false,"value":{"sessionId":"ses_1","name":"report.pdf","size":-1,"mimeType":"application/pdf","requestId":"req-1"}});
cases.push({"name":"attachment.begin params with a MIME type that is not type/subtype","check":"params","method":"attachment.begin","valid":false,"value":{"sessionId":"ses_1","name":"report.pdf","size":1,"mimeType":"pdf; charset=x","requestId":"req-1"}});
cases.push({"name":"attachment.begin result","check":"result","method":"attachment.begin","valid":true,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","state":"uploading","received":0,"size":1024,"maxChunkBytes":262144,"expiresAt":"2026-10-22T01:00:00.000Z"}});
cases.push({"name":"attachment.begin result of a repeated request already committed","check":"result","method":"attachment.begin","valid":true,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","state":"committed","received":1024,"size":1024,"maxChunkBytes":262144,"attachmentId":"att_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"attachment.begin result with a host path","check":"result","method":"attachment.begin","valid":false,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","state":"uploading","received":0,"size":1024,"maxChunkBytes":262144,"path":"/home/u/.alp/state/attachments/x/payload"}});
cases.push({"name":"attachment.chunk params","check":"params","method":"attachment.chunk","valid":true,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","offset":0,"data":"JVBERi0xLjQK"}});
cases.push({"name":"attachment.chunk params with invalid base64","check":"params","method":"attachment.chunk","valid":false,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","offset":0,"data":"not base64!"}});
cases.push({"name":"attachment.chunk params with empty data","check":"params","method":"attachment.chunk","valid":false,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","offset":0,"data":""}});
cases.push({"name":"attachment.chunk params with an id that is not an upload id","check":"params","method":"attachment.chunk","valid":false,"value":{"uploadId":"../x","offset":0,"data":"AAAA"}});
cases.push({"name":"attachment.chunk result","check":"result","method":"attachment.chunk","valid":true,"value":{"received":9,"size":1024}});
cases.push({"name":"attachment.commit params","check":"params","method":"attachment.commit","valid":true,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}});
cases.push({"name":"attachment.commit params with an uppercase digest","check":"params","method":"attachment.commit","valid":false,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef","sha256":"E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"}});
cases.push({"name":"attachment.commit result","check":"result","method":"attachment.commit","valid":true,"value":{"attachment":{"attachmentId":"att_0123456789abcdef0123456789abcdef","sessionId":"ses_1","name":"report.pdf","mimeType":"application/pdf","detectedMimeType":"application/pdf","size":1024,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","createdAt":"2026-10-22T00:00:00.000Z","committedAt":"2026-10-22T00:01:00.000Z","referenced":false}}});
cases.push({"name":"attachment.commit result with a storage path","check":"result","method":"attachment.commit","valid":false,"value":{"attachment":{"attachmentId":"att_0123456789abcdef0123456789abcdef","sessionId":"ses_1","name":"report.pdf","mimeType":"application/pdf","detectedMimeType":"application/pdf","size":1024,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","createdAt":"2026-10-22T00:00:00.000Z","committedAt":"2026-10-22T00:01:00.000Z","referenced":false,"path":"/home/u/.alp/state/attachments/x/payload"}}});
cases.push({"name":"attachment.abort params","check":"params","method":"attachment.abort","valid":true,"value":{"uploadId":"upl_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"attachment.abort result","check":"result","method":"attachment.abort","valid":true,"value":{"aborted":true}});
cases.push({"name":"attachment.get params","check":"params","method":"attachment.get","valid":true,"value":{"attachmentId":"att_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"attachment.get params with an upload id","check":"params","method":"attachment.get","valid":false,"value":{"attachmentId":"upl_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"attachment.get result of a referenced attachment","check":"result","method":"attachment.get","valid":true,"value":{"attachment":{"attachmentId":"att_0123456789abcdef0123456789abcdef","sessionId":"ses_1","name":"report.pdf","mimeType":"application/pdf","detectedMimeType":"application/pdf","size":1024,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","createdAt":"2026-10-22T00:00:00.000Z","committedAt":"2026-10-22T00:01:00.000Z","referenced":true}}});
cases.push({"name":"attachment.delete params","check":"params","method":"attachment.delete","valid":true,"value":{"attachmentId":"att_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"attachment.delete result","check":"result","method":"attachment.delete","valid":true,"value":{"deleted":true}});
cases.push({"name":"session.prompt params with an attachment part","check":"params","method":"session.prompt","valid":true,"value":{"sessionId":"ses_1","clientMessageId":"m-1","content":[{"type":"text","text":"Summarise this report"},{"type":"attachment","attachmentId":"att_0123456789abcdef0123456789abcdef"}]}});
cases.push({"name":"session.prompt params with an attachment part naming a path","check":"params","method":"session.prompt","valid":false,"value":{"sessionId":"ses_1","clientMessageId":"m-1","content":[{"type":"attachment","attachmentId":"att_0123456789abcdef0123456789abcdef","path":"/etc/passwd"}]}});
cases.push({"name":"session.prompt params with an attachment part without its id","check":"params","method":"session.prompt","valid":false,"value":{"sessionId":"ses_1","clientMessageId":"m-1","content":[{"type":"attachment","url":"https://example.com/x.pdf"}]}});
cases.push({"name":"daemon.hello result with attachment limits","check":"result","method":"daemon.hello","valid":true,"value":{"protocolVersion":1,"capabilities":["attachments"],"attachmentLimits":{"maxObjectBytes":20971520,"maxPerPrompt":8,"maxPromptBytes":41943040,"maxChunkBytes":262144,"maxActiveUploads":2,"maxPrincipalBytes":209715200,"maxDaemonBytes":1073741824,"uploadTimeoutMs":3600000,"unreferencedRetentionMs":86400000,"releasedGraceMs":604800000}}});
cases.push({"name":"daemon.hello result with partial attachment limits","check":"result","method":"daemon.hello","valid":false,"value":{"protocolVersion":1,"attachmentLimits":{"maxObjectBytes":20971520}}});
cases.push({"name":"session.fork params through a turn","check":"params","method":"session.fork","valid":true,"value":{"sessionId":"ses_1","requestId":"fork-1","ifGeneration":"0123456789abcdef0123456789abcdef","boundary":{"throughTurnId":"turn-1"}}});
cases.push({"name":"session.fork params before a turn into a workspace, with a chosen id and title","check":"params","method":"session.fork","valid":true,"value":{"sessionId":"ses_1","requestId":"fork-2","ifGeneration":"0123456789abcdef0123456789abcdef","boundary":{"beforeTurnId":"turn-2"},"workspaceId":"wks_1","newSessionId":"ses_f1","title":"Try another way"}});
cases.push({"name":"session.fork params restoring a rewound branch whole","check":"params","method":"session.fork","valid":true,"value":{"sessionId":"ses_1","requestId":"fork-3","ifGeneration":"0123456789abcdef0123456789abcdef","branchId":"br_0123456789abcdef"}});
cases.push({"name":"session.fork params with both cutoffs in one boundary","check":"params","method":"session.fork","valid":false,"value":{"sessionId":"ses_1","requestId":"fork-4","ifGeneration":"0123456789abcdef0123456789abcdef","boundary":{"throughTurnId":"turn-1","beforeTurnId":"turn-2"}}});
cases.push({"name":"session.fork params without a requestId","check":"params","method":"session.fork","valid":false,"value":{"sessionId":"ses_1","ifGeneration":"0123456789abcdef0123456789abcdef","boundary":{"throughTurnId":"turn-1"}}});
cases.push({"name":"session.fork params without the generation precondition","check":"params","method":"session.fork","valid":false,"value":{"sessionId":"ses_1","requestId":"fork-5","boundary":{"throughTurnId":"turn-1"}}});
cases.push({"name":"session.fork params naming a host path as destination","check":"params","method":"session.fork","valid":false,"value":{"sessionId":"ses_1","requestId":"fork-6","ifGeneration":"0123456789abcdef0123456789abcdef","cwd":"/etc"}});
cases.push({"name":"session.fork params with an invalid new session id","check":"params","method":"session.fork","valid":false,"value":{"sessionId":"ses_1","requestId":"fork-7","ifGeneration":"0123456789abcdef0123456789abcdef","newSessionId":"a b"}});
cases.push({"name":"session.fork result","check":"result","method":"session.fork","valid":true,"value":{"session":{"id":"ses_f1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"closed","conversation":{"fork":true,"rewind":true},"title":"Plan (fork)","forkedFrom":{"sessionId":"ses_1","turnId":"turn-1","boundary":"through","at":"2026-10-23T00:00:00.000Z"}},"forkedFrom":{"sessionId":"ses_1","turnId":"turn-1","boundary":"through","at":"2026-10-23T00:00:00.000Z"}}});
cases.push({"name":"session.fork result of a repeated request","check":"result","method":"session.fork","valid":true,"value":{"session":{"id":"ses_f1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"closed","conversation":{"fork":true,"rewind":true},"forkedFrom":{"sessionId":"ses_1","boundary":"whole","at":"2026-10-23T00:00:00.000Z","branchId":"br_0123456789abcdef"}},"forkedFrom":{"sessionId":"ses_1","boundary":"whole","branchId":"br_0123456789abcdef","at":"2026-10-23T00:00:00.000Z"},"duplicate":true}});
cases.push({"name":"session.fork result with an unknown boundary kind","check":"result","method":"session.fork","valid":false,"value":{"session":{"id":"ses_f1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"closed","conversation":{"fork":true,"rewind":true}},"forkedFrom":{"sessionId":"ses_1","turnId":"turn-1","boundary":"after","at":"2026-10-23T00:00:00.000Z"}}});
cases.push({"name":"session.rewind params","check":"params","method":"session.rewind","valid":true,"value":{"sessionId":"ses_1","requestId":"rewind-1","ifGeneration":"0123456789abcdef0123456789abcdef","beforeTurnId":"turn-2"}});
cases.push({"name":"session.rewind params without a turn","check":"params","method":"session.rewind","valid":false,"value":{"sessionId":"ses_1","requestId":"rewind-2","ifGeneration":"0123456789abcdef0123456789abcdef"}});
cases.push({"name":"session.rewind params asking to restore files","check":"params","method":"session.rewind","valid":false,"value":{"sessionId":"ses_1","requestId":"rewind-3","ifGeneration":"0123456789abcdef0123456789abcdef","beforeTurnId":"turn-2","mode":"both"}});
cases.push({"name":"session.rewind params with a malformed generation","check":"params","method":"session.rewind","valid":false,"value":{"sessionId":"ses_1","requestId":"rewind-4","ifGeneration":"g1","beforeTurnId":"turn-2"}});
cases.push({"name":"session.rewind result","check":"result","method":"session.rewind","valid":true,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"idle","conversation":{"fork":true,"rewind":true},"branches":[{"branchId":"br_0123456789abcdef","beforeTurnId":"turn-2","turns":2,"at":"2026-10-23T00:00:00.000Z"}]},"generation":"fedcba9876543210fedcba9876543210","branch":{"branchId":"br_0123456789abcdef","beforeTurnId":"turn-2","turns":2,"at":"2026-10-23T00:00:00.000Z"}}});
cases.push({"name":"session.rewind result without its branch","check":"result","method":"session.rewind","valid":false,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"closed","conversation":{"fork":true,"rewind":true}},"generation":"fedcba9876543210fedcba9876543210"}});
cases.push({"name":"history.reset envelope after a rewind","check":"envelope","valid":true,"value":{"sessionId":"ses_1","epoch":"e1","seq":9,"ts":"2026-10-23T00:00:00.000Z","event":{"type":"history.reset","generation":"fedcba9876543210fedcba9876543210","reason":"rewind","branchId":"br_0123456789abcdef"}}});
cases.push({"name":"history.reset envelope without a generation","check":"envelope","valid":false,"value":{"sessionId":"ses_1","epoch":"e1","seq":9,"ts":"2026-10-23T00:00:00.000Z","event":{"type":"history.reset","reason":"rewind","branchId":"br_0123456789abcdef"}}});
cases.push({"name":"session.reload params","check":"params","method":"session.reload","valid":true,"value":{"sessionId":"ses_1","requestId":"reload-1","ifGeneration":"0123456789abcdef0123456789abcdef"}});
cases.push({"name":"session.reload params without a generation","check":"params","method":"session.reload","valid":false,"value":{"sessionId":"ses_1","requestId":"reload-2"}});
cases.push({"name":"session.reload params naming another binding","check":"params","method":"session.reload","valid":false,"value":{"sessionId":"ses_1","requestId":"reload-3","ifGeneration":"0123456789abcdef0123456789abcdef","threadId":"thread-9"}});
cases.push({"name":"session.reload result","check":"result","method":"session.reload","valid":true,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"idle","conversation":{"fork":true,"rewind":true,"reload":true},"branches":[{"branchId":"br_0123456789abcdef","beforeTurnId":"turn-2","turns":2,"at":"2026-10-23T00:00:00.000Z"}]}}});
cases.push({"name":"session.reload result of a repeat","check":"result","method":"session.reload","valid":true,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-5.5","mode":"workspace-write","thinking":"medium","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"threadId":"thread-2","persistent":true,"busy":false,"status":"idle","conversation":{"fork":true,"rewind":true,"reload":true},"branches":[{"branchId":"br_0123456789abcdef","beforeTurnId":"turn-2","turns":2,"at":"2026-10-23T00:00:00.000Z"}]},"duplicate":true}});
cases.push({"name":"session.reload result without its session","check":"result","method":"session.reload","valid":false,"value":{"duplicate":true}});
cases.push({"name":"session.resumeCommand params","check":"params","method":"session.resumeCommand","valid":true,"value":{"sessionId":"ses_1"}});
cases.push({"name":"session.resumeCommand params asking for a native runtime","check":"params","method":"session.resumeCommand","valid":false,"value":{"sessionId":"ses_1","runtime":"claude"}});
cases.push({"name":"session.resumeCommand result","check":"result","method":"session.resumeCommand","valid":true,"value":{"argv":["alp","attach","ses_1"],"posix":"alp attach ses_1","windows":"alp attach ses_1","display":"alp attach ses_1","platform":"posix"}});
cases.push({"name":"session.resumeCommand result with an env field","check":"result","method":"session.resumeCommand","valid":false,"value":{"argv":["alp","attach","ses_1"],"posix":"alp attach ses_1","windows":"alp attach ses_1","display":"alp attach ses_1","platform":"posix","env":{"ALP_HOME":"/x"}}});
cases.push({"name":"session.resumeCommand result with a line break in an argument","check":"result","method":"session.resumeCommand","valid":false,"value":{"argv":["alp","attach","ses_1\nrm -rf ~"],"posix":"alp attach 'ses_1'","windows":"alp attach ses_1","display":"alp attach ses_1","platform":"posix"}});
cases.push({"name":"session.resumeCommand result without its Windows line","check":"result","method":"session.resumeCommand","valid":false,"value":{"argv":["alp","attach","ses_1"],"posix":"alp attach ses_1","display":"alp attach ses_1","platform":"posix"}});
cases.push({"name":"session.configure params changing model and thinking","check":"params","method":"session.configure","valid":true,"value":{"sessionId":"ses_1","model":"codex:gpt-6.1-sol","thinking":"high","requestId":"configure-1","ifGeneration":"0123456789abcdef0123456789abcdef"}});
cases.push({"name":"session.configure params changing team","check":"params","method":"session.configure","valid":true,"value":{"sessionId":"ses_1","team":"cafe","requestId":"configure-2","ifGeneration":"0123456789abcdef0123456789abcdef"}});
cases.push({"name":"session.configure params changing model without requestId","check":"params","method":"session.configure","valid":false,"value":{"sessionId":"ses_1","model":"codex:gpt-6.1-sol","ifGeneration":"0123456789abcdef0123456789abcdef"}});
cases.push({"name":"session.configure params changing team without a generation","check":"params","method":"session.configure","valid":false,"value":{"sessionId":"ses_1","team":"cafe","requestId":"configure-3"}});
cases.push({"name":"session.configure params with a malformed generation","check":"params","method":"session.configure","valid":false,"value":{"sessionId":"ses_1","thinking":"low","requestId":"configure-4","ifGeneration":"gen-1"}});
cases.push({"name":"session.configure result of a live change","check":"result","method":"session.configure","valid":true,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-6.1-sol","mode":"workspace-write","thinking":"high","workflow":{"mode":"cafe","maxPeers":2,"supervisor":true},"teamLabel":"Cafe","threadId":"thread-2","persistent":true,"busy":false,"status":"idle","conversation":{"fork":true,"rewind":true,"reload":true,"configure":true}},"configured":{"status":"applied","requested":{"model":"codex:gpt-6.1-sol","thinking":"high","team":"cafe"},"effective":{"team":"cafe","teamLabel":"Cafe","agent":"main","runtime":"codex","model":"gpt-6.1-sol","thinking":"high","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["lead"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"restarted":true}}});
cases.push({"name":"session.configure result of a repeat","check":"result","method":"session.configure","valid":true,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-6.1-sol","mode":"workspace-write","thinking":"high","workflow":{"mode":"cafe","maxPeers":2,"supervisor":true},"teamLabel":"Cafe","threadId":"thread-2","persistent":true,"busy":false,"status":"idle","conversation":{"fork":true,"rewind":true,"reload":true,"configure":true}},"configured":{"status":"unchanged","requested":{"thinking":"high"},"effective":{"team":"pho","teamLabel":"Phở","agent":"main","runtime":"codex","model":"gpt-6.1-sol","thinking":"high","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["peer","oracle","reviewer"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"restarted":false},"duplicate":true}});
cases.push({"name":"session.configure result with an unknown outcome status","check":"result","method":"session.configure","valid":false,"value":{"session":{"id":"ses_1","projectRoot":"/work/app","agent":"main","runtime":"codex","model":"gpt-6.1-sol","mode":"workspace-write","thinking":"high","workflow":{"mode":"cafe","maxPeers":2,"supervisor":true},"teamLabel":"Cafe","threadId":"thread-2","persistent":true,"busy":false,"status":"idle","conversation":{"fork":true,"rewind":true,"reload":true,"configure":true}},"configured":{"status":"maybe","requested":{},"effective":{"team":"pho","teamLabel":"Phở","agent":"main","runtime":"codex","model":"gpt-5.5","thinking":"medium","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["peer","oracle","reviewer"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"restarted":false}}});
cases.push({"name":"session.configure.preview params","check":"params","method":"session.configure.preview","valid":true,"value":{"sessionId":"ses_1","model":"claude:opus","team":"cafe"}});
cases.push({"name":"session.configure.preview params naming a path","check":"params","method":"session.configure.preview","valid":false,"value":{"sessionId":"ses_1","team":"cafe","teamPath":"/etc/teams/cafe"}});
cases.push({"name":"session.configure.preview result","check":"result","method":"session.configure.preview","valid":true,"value":{"preview":{"current":{"team":"pho","teamLabel":"Phở","agent":"main","runtime":"codex","model":"gpt-5.5","thinking":"medium","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["peer","oracle","reviewer"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"proposed":{"team":"cafe","teamLabel":"Cafe","agent":"main","runtime":"codex","model":"gpt-5.5","thinking":"medium","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["lead"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"changes":["team"],"restart":true,"allowed":true,"teams":[{"id":"pho","label":"Phở"},{"id":"cafe","label":"Cafe"}]}}});
cases.push({"name":"session.configure.preview result refused","check":"result","method":"session.configure.preview","valid":true,"value":{"preview":{"current":{"team":"pho","teamLabel":"Phở","agent":"main","runtime":"codex","model":"gpt-5.5","thinking":"medium","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["peer","oracle","reviewer"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"proposed":{"team":"pho","teamLabel":"Phở","agent":"main","runtime":"claude","model":"opus","thinking":"medium","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["peer","oracle","reviewer"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"changes":["model"],"restart":true,"allowed":false,"reason":"runtime_mismatch","message":"A session keeps its runtime; start a new session to use claude","teams":[{"id":"pho","label":"Phở"}]}}});
cases.push({"name":"session.configure.preview result without the proposed configuration","check":"result","method":"session.configure.preview","valid":false,"value":{"preview":{"current":{"team":"pho","teamLabel":"Phở","agent":"main","runtime":"codex","model":"gpt-5.5","thinking":"medium","mode":"workspace-write","supervisor":true,"maxPeers":2,"delegates":["peer","oracle","reviewer"],"tools":["alp_delegate","alp_wait","alp_send","alp_board","alp_task"],"mcpServers":[],"hooks":0,"instructionsSha":"0123456789ab"},"changes":[],"restart":false,"allowed":true,"teams":[]}}});
cases.push({"name":"session.get result of a session whose runtime reads attached files by path","check":"result","method":"session.get","valid":true,"value":{"session":{"id":"ses_fixture","projectRoot":"/work/project","agent":"main","runtime":"codex","model":"gpt-6.1-sol","mode":"workspace-write","thinking":"low","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"teamLabel":"Phở","threadId":"thread-1","persistent":true,"busy":false,"status":"idle","title":"Sửa lỗi 😀","createdAt":"2026-10-15T00:00:00.000Z","updatedAt":"2026-10-15T00:00:00.000Z","promptImages":true,"promptAttachments":["file.path"]}}});
cases.push({"name":"session.get result with an unknown attachment route","check":"result","method":"session.get","valid":false,"value":{"session":{"id":"ses_fixture","projectRoot":"/work/project","agent":"main","runtime":"codex","model":"gpt-6.1-sol","mode":"workspace-write","thinking":"low","workflow":{"mode":"pho","maxPeers":2,"supervisor":false},"teamLabel":"Phở","threadId":"thread-1","persistent":true,"busy":false,"status":"idle","title":"Sửa lỗi 😀","createdAt":"2026-10-15T00:00:00.000Z","updatedAt":"2026-10-15T00:00:00.000Z","promptImages":true,"promptAttachments":["host.path"]}}});
cases.push({"name":"item user_message with attachments by id and display name","check":"envelope","valid":true,"value":{"sessionId":"ses_fixture","epoch":"epoch-1","seq":4,"cursor":13,"ts":"2026-10-23T00:00:00.000Z","event":{"type":"item","item":{"kind":"user_message","id":"user:m-3","text":"Đọc tệp này","clientMessageId":"m-3","origin":"user","attachments":[{"attachmentId":"att_0123456789abcdef0123456789abcdef","name":"report.pdf","mimeType":"application/pdf","size":2048}]}}}});
cases.push({"name":"item user_message whose attachment names a host path","check":"envelope","valid":false,"value":{"sessionId":"ses_fixture","epoch":"epoch-1","seq":4,"cursor":13,"ts":"2026-10-23T00:00:00.000Z","event":{"type":"item","item":{"kind":"user_message","id":"user:m-4","text":"x","clientMessageId":"m-4","attachments":[{"attachmentId":"att_0123456789abcdef0123456789abcdef","name":"report.pdf","mimeType":"application/pdf","size":2048,"path":"/home/u/.alp/state/staged/att_0123456789abcdef0123456789abcdef.pdf"}]}}}});
cases.push({"name":"item user_message with an attachment id that is not one","check":"envelope","valid":false,"value":{"sessionId":"ses_fixture","epoch":"epoch-1","seq":4,"cursor":13,"ts":"2026-10-23T00:00:00.000Z","event":{"type":"item","item":{"kind":"user_message","id":"user:m-5","text":"x","clientMessageId":"m-5","attachments":[{"attachmentId":"../payload","name":"report.pdf","mimeType":"application/pdf","size":2048}]}}}});
cases.push({"name":"terminal.create params","check":"params","method":"terminal.create","valid":true,"value":{"workspaceId":"ws_1","cols":80,"rows":24,"requestId":"req-1"}});
cases.push({"name":"terminal.create params from a gateway with principal context","check":"params","method":"terminal.create","valid":true,"value":{"workspaceId":"ws_1","cols":120,"rows":40,"requestId":"req-2","principalId":"abcdef0123456789","principalEpoch":"0123456789abcdef0123456789abcdef","authorizedRoots":["/work/project"]}});
cases.push({"name":"terminal.create never takes a shell path","check":"params","method":"terminal.create","valid":false,"value":{"workspaceId":"ws_1","cols":80,"rows":24,"requestId":"req-3","shell":"/bin/bash"}});
cases.push({"name":"terminal.create never takes a command, args or env","check":"params","method":"terminal.create","valid":false,"value":{"workspaceId":"ws_1","cols":80,"rows":24,"requestId":"req-4","command":"rm","args":["-rf","/"],"env":{"PATH":"/tmp"}}});
cases.push({"name":"terminal.create never takes a cwd","check":"params","method":"terminal.create","valid":false,"value":{"workspaceId":"ws_1","cols":80,"rows":24,"requestId":"req-5","cwd":"/etc"}});
cases.push({"name":"terminal.create with a size out of bounds","check":"params","method":"terminal.create","valid":false,"value":{"workspaceId":"ws_1","cols":1,"rows":24,"requestId":"req-6"}});
cases.push({"name":"terminal.create without a requestId","check":"params","method":"terminal.create","valid":false,"value":{"workspaceId":"ws_1","cols":80,"rows":24}});
cases.push({"name":"terminal.create result","check":"result","method":"terminal.create","valid":true,"value":{"terminal":{"terminalId":"term_0123456789abcdef0123456789abcdef","workspaceId":"ws_1","title":"zsh","cols":80,"rows":24,"state":"running","attached":false,"createdAt":"2026-10-23T00:00:00.000Z","lastActivityAt":"2026-10-23T00:00:00.000Z","expiresAt":"2026-10-23T08:00:00.000Z"}}});
cases.push({"name":"terminal.create result never carries a pid","check":"result","method":"terminal.create","valid":false,"value":{"terminal":{"terminalId":"term_0123456789abcdef0123456789abcdef","workspaceId":"ws_1","title":"zsh","cols":80,"rows":24,"state":"running","attached":false,"createdAt":"2026-10-23T00:00:00.000Z","lastActivityAt":"2026-10-23T00:00:00.000Z","expiresAt":"2026-10-23T08:00:00.000Z","pid":4242}}});
cases.push({"name":"terminal.list params","check":"params","method":"terminal.list","valid":true,"value":{}});
cases.push({"name":"terminal.list params for one workspace","check":"params","method":"terminal.list","valid":true,"value":{"workspaceId":"ws_1"}});
cases.push({"name":"terminal.list result with a running and an exited terminal","check":"result","method":"terminal.list","valid":true,"value":{"terminals":[{"terminalId":"term_0123456789abcdef0123456789abcdef","workspaceId":"ws_1","title":"zsh","cols":80,"rows":24,"state":"running","attached":false,"createdAt":"2026-10-23T00:00:00.000Z","lastActivityAt":"2026-10-23T00:00:00.000Z","expiresAt":"2026-10-23T08:00:00.000Z"},{"terminalId":"term_0123456789abcdef0123456789abcdef","workspaceId":"ws_1","title":"zsh","cols":80,"rows":24,"state":"exited","attached":true,"createdAt":"2026-10-23T00:00:00.000Z","lastActivityAt":"2026-10-23T00:00:00.000Z","expiresAt":"2026-10-23T08:00:00.000Z","exitCode":0,"signal":null,"endReason":"exited"}]}});
cases.push({"name":"terminal.attach params","check":"params","method":"terminal.attach","valid":true,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"terminal.attach params after a seq","check":"params","method":"terminal.attach","valid":true,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","after":12}});
cases.push({"name":"terminal.attach with an id that is not one","check":"params","method":"terminal.attach","valid":false,"value":{"terminalId":"../term"}});
cases.push({"name":"terminal.attach result","check":"result","method":"terminal.attach","valid":true,"value":{"terminal":{"terminalId":"term_0123456789abcdef0123456789abcdef","workspaceId":"ws_1","title":"zsh","cols":80,"rows":24,"state":"running","attached":true,"createdAt":"2026-10-23T00:00:00.000Z","lastActivityAt":"2026-10-23T00:00:00.000Z","expiresAt":"2026-10-23T08:00:00.000Z"},"nextSeq":13}});
cases.push({"name":"terminal.attach result with a gap","check":"result","method":"terminal.attach","valid":true,"value":{"terminal":{"terminalId":"term_0123456789abcdef0123456789abcdef","workspaceId":"ws_1","title":"zsh","cols":80,"rows":24,"state":"running","attached":true,"createdAt":"2026-10-23T00:00:00.000Z","lastActivityAt":"2026-10-23T00:00:00.000Z","expiresAt":"2026-10-23T08:00:00.000Z"},"nextSeq":900,"gap":{"fromSeq":13,"toSeq":340}}});
cases.push({"name":"terminal.input params","check":"params","method":"terminal.input","valid":true,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","data":"ls -la\r"}});
cases.push({"name":"terminal.input params Ctrl-C","check":"params","method":"terminal.input","valid":true,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","data":"\u0003"}});
cases.push({"name":"terminal.input with empty data","check":"params","method":"terminal.input","valid":false,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","data":""}});
cases.push({"name":"terminal.input over 64 KiB","check":"params","method":"terminal.input","valid":false,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","data":'x'.repeat(65537)}});
cases.push({"name":"terminal.input result","check":"result","method":"terminal.input","valid":true,"value":{"bytes":7}});
cases.push({"name":"terminal.resize params","check":"params","method":"terminal.resize","valid":true,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","cols":132,"rows":40}});
cases.push({"name":"terminal.resize too many rows","check":"params","method":"terminal.resize","valid":false,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef","cols":132,"rows":201}});
cases.push({"name":"terminal.resize result","check":"result","method":"terminal.resize","valid":true,"value":{"cols":132,"rows":40}});
cases.push({"name":"terminal.close params","check":"params","method":"terminal.close","valid":true,"value":{"terminalId":"term_0123456789abcdef0123456789abcdef"}});
cases.push({"name":"terminal.close result","check":"result","method":"terminal.close","valid":true,"value":{"closed":true}});
cases.push({"name":"terminal.revoke params","check":"params","method":"terminal.revoke","valid":true,"value":{"principalId":"abcdef0123456789"}});
cases.push({"name":"terminal.revoke needs a principal","check":"params","method":"terminal.revoke","valid":false,"value":{}});
cases.push({"name":"terminal.revoke result","check":"result","method":"terminal.revoke","valid":true,"value":{"closed":2}});
cases.push({"name":"daemon.hello result with terminal limits","check":"result","method":"daemon.hello","valid":true,"value":{"protocolVersion":1,"capabilities":["terminal"],"terminalLimits":{"maxPerPrincipal":4,"maxPerDaemon":16,"maxInputBytes":65536,"maxOutputFrameBytes":65536,"replayBytes":1048576,"idleMs":1800000,"maxLifetimeMs":28800000,"reconnectMs":60000}}});
cases.push({"name":"daemon.hello result with incomplete terminal limits","check":"result","method":"daemon.hello","valid":false,"value":{"protocolVersion":1,"capabilities":["terminal"],"terminalLimits":{"maxPerPrincipal":4}}});
cases.push({"name":"terminal.event output notification","check":"message","valid":true,"value":{"jsonrpc":"2.0","method":"terminal.event","params":{"terminalId":"term_0123456789abcdef0123456789abcdef","type":"output","seq":1,"data":"\u001b[1mPROMPT$\u001b[0m "}}});
cases.push({"name":"terminal.event exit notification","check":"message","valid":true,"value":{"jsonrpc":"2.0","method":"terminal.event","params":{"terminalId":"term_0123456789abcdef0123456789abcdef","type":"exit","seq":2,"exitCode":null,"signal":1,"reason":"revoked"}}});
cases.push({"name":"terminal.event detached notification","check":"message","valid":true,"value":{"jsonrpc":"2.0","method":"terminal.event","params":{"terminalId":"term_0123456789abcdef0123456789abcdef","type":"detached","reason":"slow_consumer"}}});
cases.push({"name":"terminal.event output without a seq","check":"message","valid":false,"value":{"jsonrpc":"2.0","method":"terminal.event","params":{"terminalId":"term_0123456789abcdef0123456789abcdef","type":"output","data":"x"}}});
cases.push({"name":"terminal.event exit with an unknown reason","check":"message","valid":false,"value":{"jsonrpc":"2.0","method":"terminal.event","params":{"terminalId":"term_0123456789abcdef0123456789abcdef","type":"exit","seq":2,"exitCode":0,"signal":null,"reason":"crashed"}}});

// Conditional Stop is additive; keep the legacy interrupt golden values above unchanged.
cases.push({"name":"conditional interrupt params","check":"params","method":"session.interrupt","valid":true,"value":{"sessionId":"ses_fixture","turnId":"turn-1"}});
cases.push({"name":"conditional interrupt with an empty turn","check":"params","method":"session.interrupt","valid":false,"value":{"sessionId":"ses_fixture","turnId":""}});
cases.push({"name":"conditional interrupt with a non-string turn","check":"params","method":"session.interrupt","valid":false,"value":{"sessionId":"ses_fixture","turnId":42}});
cases.push({"name":"conditional interrupt canceled the target","check":"result","method":"session.interrupt","valid":true,"value":{"interrupted":true}});
cases.push({"name":"conditional interrupt left another turn untouched","check":"result","method":"session.interrupt","valid":true,"value":{"interrupted":false}});
cases.push({"name":"conditional interrupt with a non-boolean answer","check":"result","method":"session.interrupt","valid":false,"value":{"interrupted":"yes"}});
writeFileSync(out, JSON.stringify({ $comment: 'Golden v1 values (docs/protocol/alp-json-rpc-v1.md §11). check: message (one frame), envelope, params or result of `method`. Every valid case must pass schema/methods-v1.json and the TypeScript projection in src/; every invalid one must fail the schema; `projection: false` marks values the closed TypeScript unions deliberately leave out. Implementations in any language can load this file.', cases }, null, 1) + '\n');
console.log(cases.length);
