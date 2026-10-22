#!/usr/bin/env node
// Opt-in real-runtime proof of session.fork and session.rewind (docs/protocol/alp-json-rpc-v1.md §12.7,
// issue #121 branch C) on the installed Codex and Claude. It spends real turns of the user's plans
// (about 7 small turns per runtime), so it never runs in CI:
//
//   node scripts/build-workspace.mjs daemon && node test/e2e/conversation-real-e2e.mjs codex claude
//
// A real alpd runs on an isolated ALP_HOME and a temporary project with a file no step may change. Per
// runtime: two turns give codewords ALPHA and BRAVO; a fork through the first turn must see only ALPHA
// while the source still sees both; a rewind before the second turn must see only ALPHA, under the same
// session id, also after alpd restarts (the repeated request answers the same branch); the set-aside
// branch, restored as a new session, sees both again. Codex runs only when no usage window is at or below
// 10% remaining. Every native thread and session it made is deleted at the end; the log is JSONL in
// ALP_REAL_LOG_DIR (default: a temporary directory, printed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';
import { CodexTransport } from '@anhlp/alp-runtime';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALPD = path.join(here, '../../packages/daemon/dist/alpd.js');
const MODELS = { codex: process.env.ALP_REAL_CODEX_MODEL ?? 'codex:gpt-6-luna', claude: process.env.ALP_REAL_CLAUDE_MODEL ?? 'claude:claude-haiku-4-5' };
const ASK = 'In my earlier messages in this chat I asked you to remember codewords. Which ones? Reply with the codewords only, or NONE.';
const runtimes = process.argv.slice(2).filter(name => name === 'codex' || name === 'claude');
if (!runtimes.length) { console.error('usage: conversation-real-e2e.mjs codex|claude ...'); process.exit(2); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-conv-real-')));
const logDir = process.env.ALP_REAL_LOG_DIR ?? path.join(directory, 'logs');
await mkdir(logDir, { recursive: true });
const home = path.join(directory, 'home');
await mkdir(home, { mode: 0o700 });
await writeFile(path.join(home, 'settings.json'), '{}');
console.log(`ALP_HOME=${home}\nlogs=${logDir}`);
let logFile = path.join(logDir, 'run.jsonl');
const log = async entry => { const line = { at: new Date().toISOString(), ...entry }; console.log(JSON.stringify(line)); await appendFile(logFile, `${JSON.stringify(line)}\n`); };

let child;
async function startAlpd() {
  const out = openSync(path.join(logDir, 'alpd.log'), 'a');
  child = spawn(process.execPath, [ALPD], { stdio: ['ignore', out, out], env: { ...process.env, ALP_HOME: home } });
  closeSync(out);
  for (let i = 0; i < 200; i++) { const lock = await readLock(home); if (lock?.ready && lock.pid === child.pid) break; await sleep(50); }
  const client = await connect((await readLock(home)).socket, { name: 'conversation-real', version: '0' });
  return client;
}
async function stopAlpd(client) {
  const exited = once(child, 'exit');
  await client.request('daemon.shutdown').catch(() => {});
  client.close();
  await exited;
}

async function codexHeadroom() {
  const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', directory, process.env);
  try {
    await transport.initialize();
    const result = await transport.request('account/rateLimits/read', {});
    const limits = Object.values(result?.rateLimitsByLimitId ?? (result?.rateLimits ? { default: result.rateLimits } : {}));
    const windows = limits.flatMap(limit => [limit?.primary, limit?.secondary].filter(Boolean));
    // Unknown usage is not headroom: without a reading, Codex does not run.
    return { windows: windows.map(window => ({ usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins })), ok: windows.length > 0 && windows.every(window => typeof window.usedPercent === 'number' && 100 - window.usedPercent > 10) };
  } finally { await transport.close(); }
}

/** Sends `text` and waits for the turn to end; answers the last assistant message. */
async function ask(client, sessionId, id, text) {
  await client.request('session.prompt', { sessionId, clientMessageId: id, content: [{ type: 'text', text }] });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const session = (await client.request('session.get', { sessionId })).session;
    if (!session.busy && !session.activeTurnId) break;
    if (Date.now() > deadline) throw new Error(`turn ${id} did not end`);
    await sleep(500);
  }
  const items = (await client.request('session.history', { sessionId })).items.filter(item => item.event?.type === 'item' && item.event.item.kind === 'assistant_message');
  return items.at(-1)?.event.item.text ?? '';
}
const words = answer => new Set((answer.toUpperCase().match(/[A-Z]+/g) ?? []).filter(word => ['ALPHA', 'BRAVO'].includes(word)));
const turnsOf = async (client, sessionId) => (await client.request('session.history', { sessionId })).items.filter(item => item.sessionId === sessionId && item.event?.type === 'turn.started').map(item => item.event.turnId);
/** A Codex thread's turns and the end of each item's text, for a failure's log. */
async function nativeTurns(transport, threadId) {
  try {
    const { thread } = await transport.request('thread/read', { threadId, includeTurns: true });
    const textOf = item => {
      if (typeof item.text === 'string') return item.text;
      if (Array.isArray(item.content)) return item.content.map(part => part.text ?? '').join(' ');
      return '';
    };
    return thread.turns.map(turn => ({ id: turn.id, status: turn.status, items: (turn.items ?? []).map(item => ({ type: item.type, text: textOf(item).slice(-300) })) }));
  } catch (error) { return error.message; }
}
const fileHash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

const made = { codex: new Set(), claude: new Set() };
const results = {};
let client = await startAlpd();
try {
  for (const runtime of runtimes) {
    logFile = path.join(logDir, `${runtime}.jsonl`);
    if (runtime === 'codex') {
      const headroom = await codexHeadroom();
      await log({ step: 'codex.usage', ...headroom });
      if (!headroom.ok) { results.codex = 'skipped: a usage window is at or below 10% remaining'; continue; }
    }
    const project = path.join(directory, `project-${runtime}`);
    await initProject(project);
    await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
    const file = path.join(project, 'notes.txt');
    await writeFile(file, `a file no fork or rewind may change (${runtime})\n`);
    const fileBefore = await fileHash(file);
    const spec = { cwd: project, persist: true, model: MODELS[runtime], mode: 'read-only', thinking: runtime === 'codex' ? 'low' : 'low' };

    const { session } = await client.request('session.create', { spec });
    const source = session.id;
    await log({ step: 'create', runtime, sessionId: source, threadId: session.threadId, model: MODELS[runtime] });
    await log({ step: 'turn1', answer: await ask(client, source, 't1', 'Remember codeword ALPHA. Reply only OK.') });
    await log({ step: 'turn2', answer: await ask(client, source, 't2', 'Remember codeword BRAVO. Reply only OK.') });
    const [first, second] = await turnsOf(client, source);
    const sourceThread = (await client.request('session.get', { sessionId: source })).session.threadId;
    made[runtime].add(sourceThread);

    // Fork through the first turn: the fork cannot see BRAVO; the source still can.
    let generation = (await client.request('session.history', { sessionId: source, limit: 1 })).generation;
    const fork = await client.request('session.fork', { sessionId: source, requestId: 'fork-1', ifGeneration: generation, boundary: { throughTurnId: first } });
    made[runtime].add(fork.session.threadId);
    await log({ step: 'fork', forkedFrom: fork.forkedFrom, sessionId: fork.session.id, threadId: fork.session.threadId });
    await client.request('session.create', { sessionId: fork.session.id, spec, resume: true });
    const forkAnswer = await ask(client, fork.session.id, 'f1', ASK);
    const forkThread = (await client.request('session.get', { sessionId: fork.session.id })).session.threadId;
    made[runtime].add(forkThread);
    await log({ step: 'fork.ask', answer: forkAnswer, threadId: forkThread });
    assert.deepEqual([...words(forkAnswer)], ['ALPHA'], `the fork sees only ALPHA: ${forkAnswer}`);
    const sourceAnswer = await ask(client, source, 's1', ASK);
    await log({ step: 'source.ask', answer: sourceAnswer });
    assert.deepEqual([...words(sourceAnswer)].sort(), ['ALPHA', 'BRAVO'], `the source sees both: ${sourceAnswer}`);

    // Rewind the live source to before the second turn: same id, the next reply sees ALPHA only.
    generation = (await client.request('session.history', { sessionId: source, limit: 1 })).generation;
    const rewindGeneration = generation;
    const rewind = await client.request('session.rewind', { sessionId: source, requestId: 'rewind-1', ifGeneration: generation, beforeTurnId: second });
    made[runtime].add(rewind.session.threadId);
    await log({ step: 'rewind', branch: rewind.branch, generation: rewind.generation, threadId: rewind.session.threadId });
    const rewoundAnswer = await ask(client, source, 'r1', ASK);
    const rewoundThread = (await client.request('session.get', { sessionId: source })).session.threadId;
    made[runtime].add(rewoundThread);
    await log({ step: 'rewind.ask', answer: rewoundAnswer, threadId: rewoundThread });
    assert.deepEqual([...words(rewoundAnswer)], ['ALPHA'], `the rewound session sees only ALPHA: ${rewoundAnswer}`);

    // The set-aside branch is recoverable: restored as a new session (not opened yet, so for Claude only a
    // binding its first prompt makes), it must see both turns after alpd restarts.
    generation = (await client.request('session.history', { sessionId: source, limit: 1 })).generation;
    const restored = await client.request('session.fork', { sessionId: source, requestId: 'restore-1', ifGeneration: generation, branchId: rewind.branch.branchId });
    made[runtime].add(restored.session.threadId);
    await log({ step: 'branch.restore', sessionId: restored.session.id, forkedFrom: restored.forkedFrom, threadId: restored.session.threadId });

    // After a restart: the same request answers the same branch; the session continues the rewound conversation.
    await stopAlpd(client);
    client = await startAlpd();
    const original = await client.request('session.rewind', { sessionId: source, requestId: 'rewind-1', ifGeneration: rewindGeneration, beforeTurnId: second });
    await log({ step: 'rewind.repeat-after-restart', duplicate: original.duplicate, branch: original.branch });
    assert.equal(original.duplicate, true);
    assert.equal(original.branch.branchId, rewind.branch.branchId);
    await client.request('session.create', { sessionId: source, spec, resume: true });
    const restartedAnswer = await ask(client, source, 'r2', ASK);
    await log({ step: 'rewind.ask-after-restart', answer: restartedAnswer, threadId: (await client.request('session.get', { sessionId: source })).session.threadId });
    assert.deepEqual([...words(restartedAnswer)], ['ALPHA'], `after the restart, still only ALPHA: ${restartedAnswer}`);

    await client.request('session.create', { sessionId: restored.session.id, spec, resume: true });
    const restoredAnswer = await ask(client, restored.session.id, 'b1', ASK);
    const restoredThread = (await client.request('session.get', { sessionId: restored.session.id })).session.threadId;
    made[runtime].add(restoredThread);
    await log({ step: 'branch.ask-after-restart', answer: restoredAnswer, sessionId: restored.session.id, threadId: restoredThread });
    assert.deepEqual([...words(restoredAnswer)].sort(), ['ALPHA', 'BRAVO'], `the restored branch sees both: ${restoredAnswer}`);

    assert.equal(await fileHash(file), fileBefore, 'no file changed');
    await log({ step: 'files', unchanged: true, sha256: fileBefore });
    results[runtime] = 'pass';
  }
} catch (error) {
  await log({ step: 'failed', error: error?.message ?? String(error) });
  process.exitCode = 1;
} finally {
  await stopAlpd(client).catch(() => {});
  // Delete what this run made natively: Codex forks before their sources (a source with forks cannot go).
  logFile = path.join(logDir, 'cleanup.jsonl');
  if (made.codex.size) {
    const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', directory, process.env);
    try {
      await transport.initialize();
      // On a failure, what each thread holds natively, for the log.
      if (process.exitCode) for (const threadId of made.codex) await log({ step: 'debug.codex.thread', threadId, read: await nativeTurns(transport, threadId) });
      for (const threadId of [...made.codex].reverse()) await log({ step: 'cleanup.codex', threadId, ...(await transport.request('thread/delete', { threadId }).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
    } finally { await transport.close(); }
  }
  if (made.claude.size) {
    const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
    for (const threadId of made.claude) await log({ step: 'cleanup.claude', threadId, ...(await deleteSession(threadId).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
  }
  await log({ step: 'done', results });
  if (!process.env.ALP_REAL_KEEP) await rm(home, { recursive: true, force: true });
}
