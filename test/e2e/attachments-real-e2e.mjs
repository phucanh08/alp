#!/usr/bin/env node
// Opt-in real-runtime proof of non-image attachments (docs/protocol/alp-json-rpc-v1.md §12.6, issue #121
// branch J) on the installed Codex and Claude. It spends a few small real turns per runtime, so it never
// runs in CI:
//
//   node scripts/build-workspace.mjs daemon && ALP_HOME=<scratch> node test/e2e/attachments-real-e2e.mjs codex claude
//
// A real alpd runs on its own temporary ALP_HOME. Per runtime, in a read-only session (the strictest
// sandbox; nothing is widened): three files are uploaded into alpd's store (random binary with NUL bytes,
// a PDF and a UTF-8 text file, each carrying a fresh nonce) and sent in one prompt. The runtime's own tools
// must report what only reading the bytes gives (the turn's descriptor already names each file's SHA-256
// and size): each file's SHA-512, the hex of 8 bytes at a random offset of the binary, and the text
// file's secret word; and their tool calls must name each staged copy (by its masked path and id). The user_message keeps ids and names, never the staging
// path. Then alpd restarts: the retry of the same message is a duplicate, the session reads the same
// attachment again from the same staged copy, and the store holds one object. A fork of the conversation
// pins the attachment and its runtime reads the file again. Codex runs only when no usage window is at or
// below 10% remaining. Every native thread it made is deleted at the end; the log is JSONL in
// ALP_REAL_LOG_DIR (default: a temporary directory, printed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';
import { CodexTransport } from '@anhlp/alp-runtime';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALPD = path.join(here, '../../packages/daemon/dist/alpd.js');
const MODELS = { codex: process.env.ALP_REAL_CODEX_MODEL ?? 'codex:gpt-6-luna', claude: process.env.ALP_REAL_CLAUDE_MODEL ?? 'claude:claude-haiku-4-5' };
const runtimes = process.argv.slice(2).filter(name => name === 'codex' || name === 'claude');
if (!runtimes.length) { console.error('usage: attachments-real-e2e.mjs codex|claude ...'); process.exit(2); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = data => createHash('sha256').update(data).digest('hex');
const sha512 = data => createHash('sha512').update(data).digest('hex');
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-attach-real-')));
const logDir = process.env.ALP_REAL_LOG_DIR ?? path.join(directory, 'logs');
await mkdir(logDir, { recursive: true });
const home = path.join(directory, 'home');
await mkdir(home, { mode: 0o700 });
await writeFile(path.join(home, 'settings.json'), '{}');
const stageRoot = path.join(home, 'state', 'staged');
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
  return connect((await readLock(home)).socket, { name: 'attachments-real', version: '0' });
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

async function upload(client, sessionId, name, mimeType, bytes, requestId) {
  const begun = await client.request('attachment.begin', { sessionId, name, size: bytes.length, mimeType, requestId });
  for (let offset = 0; offset < bytes.length; offset += begun.maxChunkBytes) await client.request('attachment.chunk', { uploadId: begun.uploadId, offset, data: bytes.subarray(offset, offset + begun.maxChunkBytes).toString('base64') });
  return (await client.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(bytes) })).attachment;
}

/** Sends `content` and waits for the turn to end; answers the prompt's result, the last assistant message and the turn's tool calls. */
async function ask(client, sessionId, id, content) {
  const before = (await client.request('session.history', { sessionId, limit: 500 })).items.length;
  const result = await client.request('session.prompt', { sessionId, clientMessageId: id, content });
  const deadline = Date.now() + 300_000;
  for (;;) {
    const session = (await client.request('session.get', { sessionId })).session;
    if (!session.busy && !session.activeTurnId) break;
    if (Date.now() > deadline) throw new Error(`turn ${id} did not end`);
    await sleep(500);
  }
  const items = (await client.request('session.history', { sessionId, limit: 500 })).items.slice(before).map(item => item.event).filter(event => event?.type === 'item').map(event => event.item);
  return { result, answer: items.filter(item => item.kind === 'assistant_message').at(-1)?.text ?? '', tools: items.filter(item => item.kind === 'tool_call').map(item => ({ name: item.name, status: item.status, ...(item.detail?.command ? { command: item.detail.command } : {}), ...(item.detail?.path ? { path: item.detail.path } : {}) })), items };
}
const userMessages = async (client, sessionId) => (await client.request('session.history', { sessionId, limit: 500 })).items.map(item => item.event).filter(event => event?.type === 'item' && event.item.kind === 'user_message').map(event => event.item);
const stagedCopies = async () => (await readdir(stageRoot).catch(() => [])).filter(name => !name.startsWith('.'));
const storedObjects = async () => (await readdir(path.join(home, 'state', 'attachments')).catch(() => [])).filter(name => /^[0-9a-f]{32}$/.test(name));
const holders = async () => JSON.parse(await readFile(path.join(home, 'state', 'attachments', 'refs.json'), 'utf8')).holders;

const made = { codex: new Set(), claude: new Set() };
const results = {};
let client = await startAlpd();
try {
  const hello = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('attachments'), 'alpd lists attachments');
  await log({ step: 'hello', attachmentLimits: hello.attachmentLimits });
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
    const remember = async sessionId => { const threadId = (await client.request('session.get', { sessionId })).session.threadId; if (threadId) made[runtime].add(threadId); };
    await remember(id);
    await log({ step: 'create', runtime, sessionId: id, model: MODELS[runtime], mode: session.mode, promptAttachments: session.promptAttachments });
    assert.deepEqual(session.promptAttachments, ['file.path']);

    // Fresh bytes every run: a binary with NULs, a PDF and a text file, each with its own nonce.
    const nonce = randomBytes(4).toString('hex');
    const word = `kiwi${randomBytes(3).toString('hex')}`;
    const files = [
      { name: `blob-${nonce}.bin`, mimeType: 'application/octet-stream', bytes: Buffer.concat([Buffer.from([0, 0, 0xff, 0x00, 0x7f]), randomBytes(2048), Buffer.from([0, 0])]) },
      { name: `report-${nonce}.pdf`, mimeType: 'application/pdf', bytes: Buffer.from(`%PDF-1.4\n% ${nonce}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`) },
      { name: `notes-${nonce}.txt`, mimeType: 'text/plain', bytes: Buffer.from(`Hello from the attachment test.\nThe secret word is ${word}.\n`) },
    ];
    const stored = [];
    for (const [index, file] of files.entries()) stored.push(await upload(client, id, file.name, file.mimeType, file.bytes, `${runtime}-up-${index}`));
    // A repeated begin (a reconnect mid-upload) answers the same committed object.
    const repeat = await client.request('attachment.begin', { sessionId: id, name: files[0].name, size: files[0].bytes.length, mimeType: files[0].mimeType, requestId: `${runtime}-up-0` });
    assert.equal(repeat.attachmentId, stored[0].attachmentId);
    await log({ step: 'uploaded', files: stored.map((attachment, index) => ({ attachmentId: attachment.attachmentId, name: attachment.name, size: attachment.size, sha256: attachment.sha256, expected: sha(files[index].bytes) })) });
    for (const [index, attachment] of stored.entries()) assert.equal(attachment.sha256, sha(files[index].bytes));

    const offset = randomInt(16, files[0].bytes.length - 16);
    const marker = files[0].bytes.subarray(offset, offset + 8).toString('hex');
    const content = [
      { type: 'text', text: `Use your shell tool on each attached file: compute its SHA-512 (shasum -a 512 or sha512sum) and its size in bytes (wc -c). Print the 8 bytes at offset ${offset} of the .bin file as hex (xxd -s ${offset} -l 8 -p, or od). Also read the .txt file. Reply with one line per file, exactly \`<file name> <sha512> <bytes>\`, then \`HEX <the 16 hex digits>\`, then a last line \`WORD <the secret word in the .txt file>\`. Do not guess: run the tools.` },
      ...stored.map(attachment => ({ type: 'attachment', attachmentId: attachment.attachmentId })),
    ];
    const first = await ask(client, id, 't1', content);
    await remember(id);
    await log({ step: 'turn1', result: first.result, answer: first.answer, tools: first.tools, expected: files.map(file => ({ name: file.name, sha512: sha512(file.bytes), bytes: file.bytes.length })), offset, marker });
    assert.equal(first.result.outcome, 'accepted');
    for (const file of files) {
      assert.ok(first.answer.includes(sha512(file.bytes)), `${runtime} reports the SHA-512 of ${file.name}: ${first.answer}`);
      assert.ok(first.answer.includes(String(file.bytes.length)), `${runtime} reports the size of ${file.name}`);
    }
    assert.ok(first.answer.toLowerCase().replace(/\s+/g, '').includes(marker), `${runtime} read the bytes at offset ${offset}: ${first.answer}`);
    assert.ok(first.answer.includes(word), `${runtime} read the secret word`);
    const toolText = JSON.stringify(first.tools);
    for (const attachment of stored) assert.ok(toolText.includes(attachment.attachmentId), `a tool call named the staged copy of ${attachment.name}`);
    assert.ok(!toolText.includes(stageRoot), 'tool calls show the staging directory masked');
    const [message] = await userMessages(client, id);
    await log({ step: 'user_message', item: message });
    assert.deepEqual(message.attachments.map(entry => entry.attachmentId), stored.map(entry => entry.attachmentId));
    assert.ok(!JSON.stringify(message).includes(stageRoot), 'the user message names no staging path');
    const copies = await stagedCopies();
    const modes = await Promise.all(copies.map(async name => ({ name, mode: ((await lstat(path.join(stageRoot, name))).mode & 0o777).toString(8) })));
    await log({ step: 'staged', copies: modes });
    for (const { mode } of modes) assert.equal(mode, '400', 'read-only, never executable');
    const inodes = Object.fromEntries(await Promise.all(copies.map(async name => [name, (await lstat(path.join(stageRoot, name))).ino])));

    // Restart alpd: the retry is the receipt's answer; the attachment is read again from the same copy.
    await stopAlpd(client);
    client = await startAlpd();
    await client.request('session.create', { sessionId: id, spec, resume: true });
    const retry = await client.request('session.prompt', { sessionId: id, clientMessageId: 't1', content });
    await log({ step: 'retry.after-restart', retry });
    assert.equal(retry.duplicate, true, 'the earlier prompt is never delivered again');
    const again = await ask(client, id, 't2', [{ type: 'text', text: 'Run shasum -a 512 (or sha512sum) on the attached file and reply with its SHA-512 only.' }, { type: 'attachment', attachmentId: stored[0].attachmentId }]);
    await log({ step: 'turn2.after-restart', result: again.result, answer: again.answer, tools: again.tools });
    assert.ok(again.answer.includes(sha512(files[0].bytes)), `${runtime} still reads the exact bytes after the restart`);
    for (const [name, ino] of Object.entries(inodes)) assert.equal((await lstat(path.join(stageRoot, name))).ino, ino, `${name}: the verified copy is reused`);
    const objects = await storedObjects();
    await log({ step: 'store', objects: objects.length, holders: await holders() });

    // A fork of the conversation pins the attachments; its runtime reads the file again.
    const { generation } = await client.request('session.history', { sessionId: id, limit: 1 });
    const turnId = (await client.request('session.history', { sessionId: id, limit: 500 })).items.map(item => item.event).find(event => event?.type === 'turn.started')?.turnId;
    const fork = await client.request('session.fork', { sessionId: id, requestId: `${runtime}-fork`, ifGeneration: generation, boundary: { throughTurnId: turnId } });
    const forkId = fork.session.id;
    if (fork.session.threadId) made[runtime].add(fork.session.threadId);
    const pinned = (await holders())[`fork:${forkId}`];
    await log({ step: 'fork', forkId, pinned });
    assert.deepEqual([...(pinned?.attachments ?? [])].sort(), stored.map(entry => entry.attachmentId.slice(4)).sort(), 'the fork pins every attachment its kept prompt carried');
    await client.request('session.create', { sessionId: forkId, spec, resume: true });
    await remember(forkId);
    const forked = await ask(client, forkId, 'f1', [{ type: 'text', text: 'Read the .txt file attached in my first message again with your tools (cat or Read) and reply with the secret word only.' }]);
    await remember(forkId);
    await log({ step: 'fork.turn', answer: forked.answer, tools: forked.tools });
    assert.ok(forked.answer.includes(word), `${runtime}'s fork reads the attachment again: ${forked.answer}`);
    assert.equal((await storedObjects()).length, objects.length, 'the fork made no new object');
    await client.request('session.close', { sessionId: forkId }).catch(() => {});
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
      for (const threadId of [...made.codex].reverse()) await log({ step: 'cleanup.codex', threadId, ...(await transport.request('thread/delete', { threadId }).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
    } finally { await transport.close(); }
  }
  if (made.claude.size) {
    const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
    for (const threadId of [...made.claude].reverse()) await log({ step: 'cleanup.claude', threadId, ...(await deleteSession(threadId).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))) });
  }
  await log({ step: 'done', results });
  if (!process.env.ALP_REAL_KEEP) await rm(home, { recursive: true, force: true });
}
