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
];
const items = [
  { kind: 'user_message', id: 'user:m-1', text: 'Chào 👋', clientMessageId: 'm-1' },
  { kind: 'assistant_message', id: 'msg-1', text: 'Đã xong.' },
  { kind: 'notice', id: 'n-1', level: 'warning', text: 'Claude is paused' },
  { kind: 'compaction', id: 'c-1', status: 'completed', trigger: 'auto', preTokens: 180000, postTokens: 40000 },
  { kind: 'todo', id: 't-1', items: [{ id: 'bd-1', text: 'Viết test', status: 'in_progress' }] },
  { kind: 'tool_call', id: 'tc-1', callId: 'call-1', name: 'shell', status: 'completed', detail: { type: 'shell', command: 'npm test', cwd: '/work/project', output: 'ok', exitCode: 0 } },
  { kind: 'tool_call', id: 'tc-2', callId: 'call-2', name: 'alp_ask', status: 'failed', error: 'denied', detail: { type: 'unknown', input: { to: 'user' }, output: null } },
];
for (const event of events) add('envelope', `event ${event.type}${event.state ? ` ${event.state}` : ''}`, env(event));
for (const item of items) add('envelope', `item ${item.kind}${item.detail ? ` ${item.detail.type}` : ''}`, env({ type: 'item', item }));
add('envelope', 'announcement without a cursor', { sessionId: 'ses_fixture', epoch: 'announce-2026', seq: 0, ts, event: { type: 'question', question } });
add('envelope', 'a future event type (receivers ignore it)', env({ type: 'tree.renamed', title: 'x' }));
add('envelope', 'a future item kind (receivers ignore it)', env({ type: 'item', item: { kind: 'image', id: 'img-1', url: 'x' } }));
add('envelope', 'unknown envelope properties', env({ type: 'session.ready' }, { trace: { span: 'abc' } }));
add('envelope', 'negative seq', env({ type: 'session.ready' }, { seq: -1 }), false);
add('envelope', 'cursor 0', env({ type: 'session.ready' }, { cursor: 0 }), false);
add('envelope', 'item event without its item', env({ type: 'item' }), false);
add('envelope', 'known item kind missing fields', env({ type: 'item', item: { kind: 'notice', id: 'n' } }), false);
add('envelope', 'known event with a wrong enum', env({ type: 'turn.ended', turnId: 't', state: 'stopped' }), false);
add('envelope', 'missing epoch', (({ epoch, ...rest }) => rest)(env({ type: 'session.ready' })), false);

// params and results of every method
const P = (method, value, valid = true, name = 'params') => add('params', `${method} ${name}`, value, valid, method);
const R = (method, value, valid = true, name = 'result') => add('result', `${method} ${name}`, value, valid, method);
P('daemon.hello', { protocolVersion: 1, client: { name: 'paseo', version: '0.10.0' } });
P('daemon.hello', { protocolVersion: 1 }, true, 'without client');
P('daemon.hello', { protocolVersion: 1, client: 'paseo' }, false, 'with a string client');
R('daemon.hello', { protocolVersion: 1, daemonVersion: '0.10.0', pid: 42, capabilities: ['attach.after', 'prompt.receipts', 'extension.methods'] });
R('daemon.hello', { protocolVersion: 1, daemonVersion: '0.9.5', pid: 42 }, true, 'from a daemon before capabilities');
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
P('session.list', { projectRoot: '/work/project', rootsOnly: true, includeClosed: true, includeArchived: false });
P('session.list', { projectRoot: null }, false, 'with a null projectRoot');
R('session.list', { sessions: [summary] });
P('session.status', { sessionId: 'ses_fixture' });
R('session.status', { status: { rootId: 'ses_fixture', sessions: [{ ...snapshot, state: 'waiting_user', idleMs: 1200, workdir: '/work/project', unreadMail: 0 }], assignments: [{ id: 'ses_child', agent: 'peer', mode: 'workspace-write', status: 'running', startedAt: ts, requester: 'ses_fixture', isolation: 'shared', idleMs: 5 }], questions: [question], worktrees: [], leases: [{ checkout: '/work/project', assignmentId: 'ses_child', agent: 'peer' }], claims: [pin] } });
P('session.message', { sessionId: 'ses_fixture', text: 'Ghi chú' }); R('session.message', {});
P('session.log', { sessionId: 'ses_fixture' }); R('session.log', { rootId: 'ses_fixture', entries: [{ ts, event: 'assignment.finished', assignmentId: 'a_1' }] });
P('extension.register', { method: 'web.pairing' }); R('extension.register', { registered: 'web.pairing' });
P('extension.unregister', { method: 'web.pairing' }); R('extension.unregister', { unregistered: 'web.pairing' });

P('daemon.hello', { protocolVersion: '1' }, false, 'with a string protocolVersion');
P('session.list', { includeClosed: 'yes' }, false, 'with a string flag');
P('extension.register', {}, false, 'without method');
P('question.answer', { text: 'có' }, false, 'without questionId');
R('session.prompt', { outcome: 'unknown' }, false, 'result with outcome unknown (that is an error, never a result)');
add('envelope', 'fractional cursor', env({ type: 'session.ready' }, { cursor: 1.5 }), false);
for (const fixture of cases) if (['a future event type (receivers ignore it)', 'a future item kind (receivers ignore it)', 'unknown envelope properties'].includes(fixture.name)) fixture.projection = false;
writeFileSync(out, JSON.stringify({ $comment: 'Golden v1 values (docs/protocol/alp-json-rpc-v1.md §11). check: message (one frame), envelope, params or result of `method`. Every valid case must pass schema/methods-v1.json and the TypeScript projection in src/; every invalid one must fail the schema; `projection: false` marks values the closed TypeScript unions deliberately leave out. Implementations in any language can load this file.', cases }, null, 1) + '\n');
console.log(cases.length);
