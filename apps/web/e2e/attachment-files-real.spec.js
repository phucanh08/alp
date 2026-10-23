// Opt-in real-runtime proof of files attached in the browser (#121 J): a person drops one file and
// picks another in the real UI, through a real gateway and a real alpd, to the installed Codex and
// Claude. Their own tools must report each file's exact SHA-256 and byte count. It spends real turns,
// so it runs only when asked:
//
//   ALP_WEB_E2E_REAL_RUNTIMES=codex,claude npx playwright test e2e/attachment-files-real.spec.js --project=desktop
//
// Each session is created read-only (the strictest sandbox) by the host's owner on a small model, then
// opened in the browser. ALP_WEB_E2E_REAL_LOG names a JSONL file for the evidence (default: beside the
// world's logs). Codex runs only when no usage window is at or below 10% remaining.
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { connect as connectSocket } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { assistant, connect, idle } from './support/app.js';

const wanted = (process.env.ALP_WEB_E2E_REAL_RUNTIMES ?? '').split(',').map(name => name.trim()).filter(name => name === 'codex' || name === 'claude');
const MODELS = { codex: process.env.ALP_REAL_CODEX_MODEL ?? 'codex:gpt-6-luna', claude: process.env.ALP_REAL_CLAUDE_MODEL ?? 'claude:claude-haiku-4-5' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test.describe.configure({ mode: 'serial', timeout: 600_000 });
test.skip(!wanted.length, 'Real runtimes only when ALP_WEB_E2E_REAL_RUNTIMES names codex and/or claude');

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** @type {any} */
let owner;
let logFile = '';
test.beforeAll(async () => {
  world = await startWorld({ provider: 'real' });
  owner = await connectSocket(world.socket, { name: 'web-real-e2e', version: '0' });
  logFile = process.env.ALP_WEB_E2E_REAL_LOG ?? path.join(world.directory, 'real-runtimes.jsonl');
  console.log(`evidence: ${logFile}\nalpd log: ${world.logs.alpd}`);
});
test.afterAll(async () => { owner?.close(); await world?.close(); });

const log = async entry => { const line = JSON.stringify({ at: new Date().toISOString(), ...entry }); console.log(line); await appendFile(logFile, `${line}\n`); };

/** Drops files on the composer as a person drags them from the desktop. */
async function dropFiles(page, files) {
  await page.getByTestId('composer-box').evaluate((box, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([Uint8Array.from(atob(entry.base64), char => char.charCodeAt(0))], entry.name, { type: entry.type }));
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files.map(file => ({ name: file.name, type: file.type, base64: file.buffer.toString('base64') })));
}

for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: a dropped and a picked file are read byte for byte by the runtime's own tools`, async ({ page }) => {
    test.skip(!wanted.includes(runtime), `${runtime} not asked for`);
    if (runtime === 'codex') {
      const { CodexTransport } = await import('@anhlp/alp-runtime');
      const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', world.directory, { ...process.env, ALP_HOME: world.home });
      await transport.initialize();
      const result = await transport.request('account/rateLimits/read', {}).finally(() => transport.close());
      const windows = Object.values(result?.rateLimitsByLimitId ?? (result?.rateLimits ? { default: result.rateLimits } : {})).flatMap(limit => [limit?.primary, limit?.secondary].filter(Boolean));
      await log({ step: 'codex.usage', windows: windows.map(window => ({ usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins })) });
      test.skip(!windows.length || windows.some(window => typeof window.usedPercent !== 'number' || 100 - window.usedPercent <= 10), 'Codex usage is at or below 10% remaining (or unknown)');
    }
    const title = `Real ${runtime} files`;
    const { session } = await owner.request('session.create', { spec: { cwd: world.projects.main, persist: true, model: MODELS[runtime], mode: 'read-only', thinking: 'low' } });
    await owner.request('session.rename', { sessionId: session.id, title });
    await log({ step: 'create', runtime, sessionId: session.id, model: MODELS[runtime], promptAttachments: session.promptAttachments });
    expect(session.promptAttachments).toEqual(['file.path']);

    await connect(page, world, world.tokens.fileWriter);
    await page.getByRole('button', { name: title }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();

    const nonce = randomBytes(4).toString('hex');
    const word = `plum${randomBytes(3).toString('hex')}`;
    const binary = Buffer.concat([Buffer.from([0, 0xff, 0, 0x7f]), randomBytes(1500), Buffer.from([0])]);
    const text = Buffer.from(`Attached from the browser.\nThe secret word is ${word}.\n`);
    const files = [{ name: `blob-${nonce}.bin`, bytes: binary }, { name: `notes-${nonce}.txt`, bytes: text }];
    await dropFiles(page, [{ name: files[0].name, type: 'application/octet-stream', buffer: binary }]);
    await page.getByTestId('composer-attach-input').setInputFiles([{ name: files[1].name, mimeType: 'text/plain', buffer: text }]);
    await expect(page.getByTestId('composer-file')).toHaveCount(2);
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill('Use your shell tool on each attached file: compute its SHA-256 (shasum -a 256 or sha256sum) and its size in bytes (wc -c), and read the .txt file. Reply with one line per file, exactly `<file name> <sha256> <bytes>`, then a last line `WORD <the secret word>`. Run the tools; do not guess.');
    await composer.press('Enter');
    await expect(page.getByTestId('user-message-file')).toHaveCount(2, { timeout: 60_000 });
    const reply = assistant(page).last();
    for (const file of files) await expect(reply).toContainText(sha256(file.bytes), { timeout: 300_000 });
    await idle(page);
    const answer = await reply.innerText();
    await log({ step: 'reply', runtime, answer, expected: files.map(file => ({ name: file.name, sha256: sha256(file.bytes), bytes: file.bytes.length })), word });
    for (const file of files) expect(answer).toContain(String(file.bytes.length));
    expect(answer).toContain(word);

    const history = await owner.request('session.history', { sessionId: session.id, limit: 500 });
    const items = history.items.map(item => item.event).filter(event => event?.type === 'item').map(event => event.item);
    const message = items.find(item => item.kind === 'user_message');
    const tools = items.filter(item => item.kind === 'tool_call').map(item => ({ name: item.name, status: item.status, command: item.detail?.command }));
    await log({ step: 'timeline', runtime, userMessage: message, tools });
    expect(message.attachments.map(entry => entry.name)).toEqual(files.map(file => file.name));
    expect(tools.length).toBeGreaterThan(0);
    // Neither the page nor the timeline names where the host stages the copies.
    const home = await realpath(world.home);
    const html = await page.content();
    for (const hidden of [world.home, home]) {
      expect(html).not.toContain(hidden);
      expect(JSON.stringify(history)).not.toContain(path.join(hidden, 'state', 'staged'));
    }
    const stored = (await world.storedAttachments()).filter(entry => entry.sessionId === session.id);
    await log({ step: 'store', runtime, stored, receipts: (await world.promptReceipts(session.id)).length });
    expect(stored.map(entry => [entry.name, entry.state, entry.sha256]).sort()).toEqual(files.map(file => [file.name, 'committed', sha256(file.bytes)]).sort());
    expect(await world.promptReceipts(session.id)).toHaveLength(1);
    const { threadId } = (await owner.request('session.get', { sessionId: session.id })).session;
    await owner.request('session.close', { sessionId: session.id }).catch(() => {});
    // The native thread goes: the user's real Codex and Claude histories keep nothing of this test.
    if (runtime === 'codex') {
      const { CodexTransport } = await import('@anhlp/alp-runtime');
      const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', world.directory, { ...process.env, ALP_HOME: world.home });
      await transport.initialize();
      await log({ step: 'cleanup', runtime, threadId, deleted: await transport.request('thread/delete', { threadId }).then(() => true, error => error.message).finally(() => transport.close()) });
    } else {
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
      await log({ step: 'cleanup', runtime, threadId, deleted: await deleteSession(threadId).then(() => true, error => error.message) });
    }
  });
}
