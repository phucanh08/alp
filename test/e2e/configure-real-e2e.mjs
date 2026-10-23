#!/usr/bin/env node
// Opt-in real-runtime proof of a live session.configure (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121
// branch D) on the installed Codex and Claude. It spends four small real turns per runtime, so it never runs
// in CI:
//
//   node scripts/build-workspace.mjs daemon && ALP_HOME=<scratch> node test/e2e/configure-real-e2e.mjs codex claude
//
// A real alpd runs on its own temporary ALP_HOME. Per runtime, on a Phở root with model A: one turn gives
// codeword ALPHA; a change while a turn runs is refused session_busy and a model of the other runtime
// runtime_mismatch, both changing nothing; session.configure.preview, then session.configure to model B,
// another effort and team Cafe restarts the native process on the same thread (the run log says
// session.configured, with the model Codex answered); the next reply still names ALPHA and the runtime's own
// records show model B (Codex: the rollout's turn_context; Claude: the model its init message reports, and
// the transcript's assistant messages). Close and reopen, and a restart of alpd, keep model B and Cafe, and
// the next reply still names ALPHA. Codex runs only when no usage window is at or below 10% remaining. Every
// native thread it made is deleted at the end; the log is JSONL in ALP_REAL_LOG_DIR (default: a temporary
// directory, printed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';
import { CodexTransport } from '@anhlp/alp-runtime';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALPD = path.join(here, '../../packages/daemon/dist/alpd.js');
/** Model A each root starts with, model B and the effort it changes to. */
const PLAN = {
  codex: { from: process.env.ALP_REAL_CODEX_MODEL ?? 'codex:gpt-6-luna', to: process.env.ALP_REAL_CODEX_MODEL_B ?? 'codex:gpt-6.1-sol', thinking: 'medium', other: 'claude:claude-haiku-4-5' },
  claude: { from: process.env.ALP_REAL_CLAUDE_MODEL ?? 'claude:claude-haiku-4-5', to: process.env.ALP_REAL_CLAUDE_MODEL_B ?? 'claude:claude-sonnet-4-6', thinking: 'medium', other: 'codex:gpt-6-luna' },
};
const ASK = 'In my earlier message in this chat I asked you to remember a codeword. Which one? Reply with the codeword only, or NONE.';
const runtimes = process.argv.slice(2).filter(name => name === 'codex' || name === 'claude');
if (!runtimes.length) { console.error('usage: configure-real-e2e.mjs codex|claude ...'); process.exit(2); }
const native = id => id.slice(id.indexOf(':') + 1);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-configure-real-')));
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
  return connect((await readLock(home)).socket, { name: 'configure-real', version: '0' });
}
async function stopAlpd(client) {
  const exited = once(child, 'exit');
  await client.request('daemon.shutdown').catch(() => {});
  client.close();
  await exited;
}

async function withCodex(work) {
  const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', directory, childEnv);
  try { await transport.initialize(); return await work(transport); } finally { await transport.close(); }
}
async function codexHeadroom() {
  return withCodex(async transport => {
    const result = await transport.request('account/rateLimits/read', {});
    const limits = Object.values(result?.rateLimitsByLimitId ?? (result?.rateLimits ? { default: result.rateLimits } : {}));
    const windows = limits.flatMap(limit => [limit?.primary, limit?.secondary].filter(Boolean));
    // Unknown usage is not headroom: without a reading, Codex does not run.
    return { windows: windows.map(window => ({ usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins })), ok: windows.length > 0 && windows.every(window => typeof window.usedPercent === 'number' && 100 - window.usedPercent > 10) };
  });
}

/** Codex's own record of a thread: its model and effort, and each turn's model and effort from the rollout. */
async function codexRecord(threadId) {
  return withCodex(async transport => {
    const { thread } = await transport.request('thread/read', { threadId });
    const lines = thread?.path ? (await readFile(thread.path, 'utf8').catch(() => '')).split('\n').filter(Boolean) : [];
    const turns = lines.map(line => { try { return JSON.parse(line); } catch { return undefined; } })
      .filter(entry => entry?.type === 'turn_context')
      .map(entry => ({ model: entry.payload?.model, effort: entry.payload?.effort ?? entry.payload?.reasoning_effort }));
    return { model: thread?.model, reasoningEffort: thread?.reasoningEffort, turns };
  });
}

/** Claude Code's own transcript of a session: the model of each assistant message. */
async function claudeRecord(threadId) {
  const projects = path.join(homedir(), '.claude', 'projects');
  for (const name of await readdir(projects).catch(() => [])) {
    const text = await readFile(path.join(projects, name, `${threadId}.jsonl`), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const models = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
      .filter(entry => entry?.type === 'assistant' && typeof entry.message?.model === 'string').map(entry => entry.message.model);
    return { assistantModels: models };
  }
  return { assistantModels: [] };
}

async function idle(client, sessionId, what) {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const session = (await client.request('session.get', { sessionId })).session;
    if (!session.busy && !session.activeTurnId) return session;
    if (Date.now() > deadline) throw new Error(`${what} did not end`);
    await sleep(500);
  }
}
/** Sends `text` and waits for the turn to end; answers the last assistant message. */
async function ask(client, sessionId, id, text) {
  await client.request('session.prompt', { sessionId, clientMessageId: id, content: [{ type: 'text', text }] });
  await idle(client, sessionId, `turn ${id}`);
  const items = (await client.request('session.history', { sessionId })).items.filter(item => item.event?.type === 'item' && item.event.item.kind === 'assistant_message');
  return items.at(-1)?.event.item.text ?? '';
}
const runEvents = async sessionId => (await readFile(path.join(home, 'runs', `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const generationOf = async (client, sessionId) => (await client.request('session.history', { sessionId, limit: 1 })).generation;
const refusal = promise => promise.then(() => null, error => ({ code: error.code, reason: error.data?.reason, action: error.data?.action }));
const evidence = async (runtime, threadId, sessionId) => runtime === 'codex'
  ? { codex: await codexRecord(threadId) }
  : { claude: await claudeRecord(threadId), nativeModel: (await runEvents(sessionId)).filter(event => event.event === 'session.native_model').map(event => ({ model: event.model, configured: event.configured })) };

const made = { codex: new Set(), claude: new Set() };
const results = {};
let client = await startAlpd();
try {
  const hello = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('session.configure.live'), 'alpd lists session.configure.live');
  for (const runtime of runtimes) {
    logFile = path.join(logDir, `${runtime}.jsonl`);
    if (runtime === 'codex') {
      const headroom = await codexHeadroom();
      await log({ step: 'codex.usage', ...headroom });
      if (!headroom.ok) { results.codex = 'skipped: a usage window is at or below 10% remaining'; continue; }
    }
    const plan = PLAN[runtime];
    const project = path.join(directory, `project-${runtime}`);
    await initProject(project);
    await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'pho', supervisor: false } }));
    const { session } = await client.request('session.create', { spec: { cwd: project, persist: true, model: plan.from, mode: 'read-only', thinking: 'low' } });
    const id = session.id;
    await log({ step: 'create', runtime, sessionId: id, threadId: session.threadId, model: session.model, thinking: session.thinking, team: session.workflow.mode, conversation: session.conversation });
    assert.equal(session.workflow.mode, 'pho');

    await log({ step: 'turn1', answer: await ask(client, id, 't1', 'Remember codeword ALPHA. Reply only OK.') });
    const before = (await client.request('session.get', { sessionId: id })).session;
    made[runtime].add(before.threadId);
    assert.equal(before.conversation.configure, true);

    // A change while a turn runs: refused, nothing changed.
    await client.request('session.prompt', { sessionId: id, clientMessageId: 't2', content: [{ type: 'text', text: 'Reply only OK.' }] });
    const busy = await refusal(client.request('session.configure', { sessionId: id, model: plan.to, requestId: 'busy-1', ifGeneration: await generationOf(client, id) }));
    await log({ step: 'configure.while-busy', refused: busy });
    assert.deepEqual(busy, { code: 1004, reason: 'session_busy', action: undefined });
    await idle(client, id, 'turn t2');
    // Another runtime's model: never a migration.
    const migration = await refusal(client.request('session.configure', { sessionId: id, model: plan.other, requestId: 'other-1', ifGeneration: await generationOf(client, id) }));
    await log({ step: 'configure.other-runtime', refused: migration });
    assert.deepEqual(migration, { code: 1005, reason: 'runtime_mismatch', action: 'session.create' });
    const unchanged = (await client.request('session.get', { sessionId: id })).session;
    assert.equal(unchanged.model, before.model);
    assert.equal(unchanged.threadId, before.threadId);

    const { preview } = await client.request('session.configure.preview', { sessionId: id, model: plan.to, thinking: plan.thinking, team: 'cafe' });
    await log({ step: 'preview', changes: preview.changes, allowed: preview.allowed, restart: preview.restart, current: { model: preview.current.model, thinking: preview.current.thinking, team: preview.current.team, delegates: preview.current.delegates }, proposed: { model: preview.proposed.model, thinking: preview.proposed.thinking, team: preview.proposed.team, delegates: preview.proposed.delegates } });
    assert.equal(preview.allowed, true);
    assert.deepEqual(preview.changes, ['model', 'thinking', 'team']);

    const params = { sessionId: id, model: plan.to, thinking: plan.thinking, team: 'cafe', requestId: 'configure-1', ifGeneration: await generationOf(client, id) };
    const configured = await client.request('session.configure', params);
    const events = (await runEvents(id)).filter(event => event.event === 'session.configured' || event.event === 'session.configure_failed');
    await log({ step: 'configure', session: { model: configured.session.model, thinking: configured.session.thinking, team: configured.session.workflow.mode, teamLabel: configured.session.teamLabel, threadId: configured.session.threadId }, configured: { status: configured.configured.status, restarted: configured.configured.restarted, effective: { model: configured.configured.effective.model, thinking: configured.configured.effective.thinking, team: configured.configured.effective.team, delegates: configured.configured.effective.delegates } }, runLog: events });
    assert.equal(configured.session.model, native(plan.to));
    assert.equal(configured.session.thinking, plan.thinking);
    assert.equal(configured.session.workflow.mode, 'cafe');
    assert.equal(configured.session.threadId, before.threadId, 'the same native thread');
    assert.equal(configured.configured.restarted, true);
    assert.deepEqual(events.map(event => event.event), ['session.configured']);
    if (runtime === 'codex') assert.equal(events[0].native?.model, native(plan.to), 'Codex answered the new model');
    const repeat = await client.request('session.configure', params);
    assert.equal(repeat.duplicate, true);

    const answer = await ask(client, id, 'a1', ASK);
    await log({ step: 'ask.after-configure', answer, ...(await evidence(runtime, before.threadId, id)) });
    assert.match(answer.toUpperCase(), /ALPHA/, `the reconfigured agent still sees ALPHA: ${answer}`);
    const proof = await evidence(runtime, before.threadId, id);
    if (runtime === 'codex') assert.equal(proof.codex.turns.at(-1)?.model, native(plan.to), 'Codex ran the turn on the new model');
    else assert.equal(proof.nativeModel.at(-1)?.model, native(plan.to), 'Claude Code reports the new model');

    // Close and reopen: the same model, effort and team.
    await client.request('session.close', { sessionId: id });
    await client.request('session.create', { sessionId: id, spec: { cwd: project }, resume: true });
    const reopened = (await client.request('session.get', { sessionId: id })).session;
    await log({ step: 'reopen', model: reopened.model, thinking: reopened.thinking, team: reopened.workflow.mode, threadId: reopened.threadId });
    assert.equal(reopened.model, native(plan.to));
    assert.equal(reopened.thinking, plan.thinking);
    assert.equal(reopened.workflow.mode, 'cafe');
    const again = await ask(client, id, 'a2', ASK);
    const reopenProof = await evidence(runtime, before.threadId, id);
    await log({ step: 'ask.after-reopen', answer: again, ...reopenProof });
    assert.match(again.toUpperCase(), /ALPHA/);
    if (runtime === 'codex') assert.equal(reopenProof.codex.turns.at(-1)?.model, native(plan.to));
    else assert.equal(reopenProof.nativeModel.at(-1)?.model, native(plan.to));

    // A restart of alpd: its record still says model B and Cafe.
    await client.request('session.close', { sessionId: id }).catch(() => {});
    await stopAlpd(client);
    client = await startAlpd();
    await client.request('daemon.hello', { protocolVersion: 1 });
    await client.request('session.create', { sessionId: id, spec: { cwd: project }, resume: true });
    const restarted = (await client.request('session.get', { sessionId: id })).session;
    await log({ step: 'alpd.restart', model: restarted.model, thinking: restarted.thinking, team: restarted.workflow.mode, threadId: restarted.threadId });
    assert.equal(restarted.model, native(plan.to));
    assert.equal(restarted.workflow.mode, 'cafe');
    assert.equal(restarted.threadId, before.threadId);
    await client.request('session.close', { sessionId: id }).catch(() => {});
    results[runtime] = 'pass';
  }
} catch (error) {
  await log({ step: 'failed', error: error?.message ?? String(error), stack: error?.stack?.split('\n').slice(0, 4).join(' | ') });
  process.exitCode = 1;
} finally {
  await stopAlpd(client).catch(() => {});
  logFile = path.join(logDir, 'cleanup.jsonl');
  if (made.codex.size) {
    await withCodex(async transport => {
      for (const threadId of made.codex) await log({ step: 'cleanup.codex', threadId, ...(await transport.request('thread/delete', { threadId }).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
    }).catch(error => log({ step: 'cleanup.codex', error: error.message }));
  }
  if (made.claude.size) {
    const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
    for (const threadId of made.claude) await log({ step: 'cleanup.claude', threadId, ...(await deleteSession(threadId).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
  }
  await log({ step: 'done', results });
  if (!process.env.ALP_REAL_KEEP) await rm(home, { recursive: true, force: true });
}
