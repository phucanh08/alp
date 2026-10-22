#!/usr/bin/env node
// Opt-in real-runtime proof of session.reload (docs/protocol/alp-json-rpc-v1.md §12.8, issue #121 branch
// G2) on the installed Codex and Claude. It spends two small real turns per runtime, so it never runs in CI:
//
//   node scripts/build-workspace.mjs daemon && ALP_HOME=<scratch> node test/e2e/reload-real-e2e.mjs codex claude
//
// A real alpd runs on its own temporary ALP_HOME. Per runtime: a root that was never prompted is refused
// (1005 no_history: a Claude root then has no transcript, and a reload must never start an empty one);
// one turn gives codeword ALPHA; session.reload restarts the native process on the same thread with the
// same configuration (the run log says session.reloaded), keeping id, history and receipts; the next reply,
// from the new process, must still name ALPHA. session.resumeCommand answers `alp attach <id>`. Codex runs
// only when no usage window is at or below 10% remaining. Every native thread it made is deleted at the
// end; the log is JSONL in ALP_REAL_LOG_DIR (default: a temporary directory, printed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
const ASK = 'In my earlier message in this chat I asked you to remember a codeword. Which one? Reply with the codeword only, or NONE.';
const runtimes = process.argv.slice(2).filter(name => name === 'codex' || name === 'claude');
if (!runtimes.length) { console.error('usage: reload-real-e2e.mjs codex|claude ...'); process.exit(2); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-reload-real-')));
const logDir = process.env.ALP_REAL_LOG_DIR ?? path.join(directory, 'logs');
await mkdir(logDir, { recursive: true });
const home = path.join(directory, 'home');
await mkdir(home, { mode: 0o700 });
await writeFile(path.join(home, 'settings.json'), '{}');
console.log(`ALP_HOME=${home}\nlogs=${logDir}`);
let logFile = path.join(logDir, 'run.jsonl');
const log = async entry => { const line = { at: new Date().toISOString(), ...entry }; console.log(JSON.stringify(line)); await appendFile(logFile, `${JSON.stringify(line)}\n`); };
// The child gets this run's home and run log only, never the caller's.
const childEnv = { ...process.env, ALP_HOME: home, ALP_RUN_LOG_DIR: path.join(home, 'runs') };

let child;
async function startAlpd() {
  const out = openSync(path.join(logDir, 'alpd.log'), 'a');
  child = spawn(process.execPath, [ALPD], { stdio: ['ignore', out, out], env: childEnv });
  closeSync(out);
  for (let i = 0; i < 200; i++) { const lock = await readLock(home); if (lock?.ready && lock.pid === child.pid) break; await sleep(50); }
  return connect((await readLock(home)).socket, { name: 'reload-real', version: '0' });
}
async function stopAlpd(client) {
  const exited = once(child, 'exit');
  await client.request('daemon.shutdown').catch(() => {});
  client.close();
  await exited;
}

async function codexHeadroom() {
  const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', directory, childEnv);
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
const runEvents = async sessionId => (await readFile(path.join(home, 'runs', `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const generationOf = async (client, sessionId) => (await client.request('session.history', { sessionId, limit: 1 })).generation;

const made = { codex: new Set(), claude: new Set() };
const results = {};
let client = await startAlpd();
try {
  const hello = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('session.reload') && hello.capabilities.includes('session.resumeCommand'), 'alpd lists session.reload and session.resumeCommand');
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
    const spec = { cwd: project, persist: true, model: MODELS[runtime], mode: 'read-only', thinking: 'low' };

    const { session } = await client.request('session.create', { spec });
    const id = session.id;
    await log({ step: 'create', runtime, sessionId: id, threadId: session.threadId, model: MODELS[runtime] });
    // Never prompted: refused, nothing restarted (a Claude root has no transcript yet).
    const fresh = await client.request('session.reload', { sessionId: id, requestId: 'reload-0', ifGeneration: await generationOf(client, id) }).then(() => null, error => ({ code: error.code, reason: error.data?.reason }));
    await log({ step: 'reload.never-prompted', refused: fresh });
    assert.deepEqual(fresh, { code: 1005, reason: 'no_history' });

    await log({ step: 'turn1', answer: await ask(client, id, 't1', 'Remember codeword ALPHA. Reply only OK.') });
    const before = (await client.request('session.get', { sessionId: id })).session;
    made[runtime].add(before.threadId);
    const historyBefore = await client.request('session.history', { sessionId: id, limit: 200 });
    const reloaded = await client.request('session.reload', { sessionId: id, requestId: 'reload-1', ifGeneration: historyBefore.generation });
    const events = (await runEvents(id)).filter(event => event.event === 'session.reloaded' || event.event === 'session.reload_failed');
    await log({ step: 'reload', threadId: reloaded.session.threadId, model: reloaded.session.model, mode: reloaded.session.mode, thinking: reloaded.session.thinking, runLog: events });
    assert.equal(reloaded.session.id, id);
    assert.equal(reloaded.session.threadId, before.threadId, 'the same native thread');
    for (const key of ['model', 'mode', 'thinking', 'agent', 'runtime']) assert.equal(reloaded.session[key], before[key], key);
    assert.deepEqual(events.map(event => [event.event, event.threadId]), [['session.reloaded', before.threadId]]);
    const historyAfter = await client.request('session.history', { sessionId: id, limit: 200 });
    assert.equal(historyAfter.generation, historyBefore.generation, 'the history generation stays');
    assert.deepEqual(historyAfter.items.slice(0, historyBefore.items.length), historyBefore.items, 'the history stays');
    const repeat = await client.request('session.reload', { sessionId: id, requestId: 'reload-1', ifGeneration: historyBefore.generation });
    assert.equal(repeat.duplicate, true);
    const receipt = await client.request('session.prompt', { sessionId: id, clientMessageId: 't1', content: [{ type: 'text', text: 'Remember codeword ALPHA. Reply only OK.' }] });
    await log({ step: 'receipt', duplicate: receipt.duplicate });
    assert.equal(receipt.duplicate, true, 'the earlier prompt is never delivered again');

    // The next reply comes from the new process and still sees the earlier turn.
    const answer = await ask(client, id, 'a1', ASK);
    const after = (await client.request('session.get', { sessionId: id })).session;
    await log({ step: 'ask.after-reload', answer, threadId: after.threadId });
    assert.match(answer.toUpperCase(), /ALPHA/, `the reloaded agent still sees ALPHA: ${answer}`);
    assert.equal(after.threadId, before.threadId);

    const command = await client.request('session.resumeCommand', { sessionId: id });
    await log({ step: 'resumeCommand', command });
    assert.deepEqual(command.argv, ['alp', 'attach', id]);
    assert.ok(!JSON.stringify(command).includes(home) && !JSON.stringify(command).includes(before.threadId), 'no path or native id');
    await client.request('session.close', { sessionId: id }).catch(() => {});
    results[runtime] = 'pass';
  }
} catch (error) {
  await log({ step: 'failed', error: error?.message ?? String(error) });
  process.exitCode = 1;
} finally {
  await stopAlpd(client).catch(() => {});
  logFile = path.join(logDir, 'cleanup.jsonl');
  if (made.codex.size) {
    const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', directory, childEnv);
    try {
      await transport.initialize();
      for (const threadId of made.codex) await log({ step: 'cleanup.codex', threadId, ...(await transport.request('thread/delete', { threadId }).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
    } finally { await transport.close(); }
  }
  if (made.claude.size) {
    const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
    for (const threadId of made.claude) await log({ step: 'cleanup.claude', threadId, ...(await deleteSession(threadId).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
  }
  await log({ step: 'done', results });
  if (!process.env.ALP_REAL_KEEP) await rm(home, { recursive: true, force: true });
}
