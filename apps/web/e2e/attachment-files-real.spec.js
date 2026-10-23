// Opt-in real-runtime proof of files attached in the browser (#121 J): a person drops one file and
// picks another in the real UI, through a real gateway and a real alpd, to the installed Codex and
// Claude. Their own tools must report each file's exact SHA-256 and byte count. It spends real turns,
// so it runs only when asked:
//
//   ALP_WEB_E2E_REAL_RUNTIMES=codex,claude npx playwright test e2e/attachment-files-real.spec.js --project=desktop
//
// Each session is created read-only (the strictest sandbox) by the host's owner on a small model, then
// opened in the browser. The turn's descriptor of a file already names its SHA-256 and size, so the
// proof asks for what only reading the bytes gives: each file's SHA-512 and the hex of 8 bytes at a
// random offset of the binary. ALP_WEB_E2E_REAL_LOG names a JSONL file for the evidence (default: beside the
// world's logs). Codex runs only when no usage window is at or below 10% remaining.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { connect as connectSocket } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { assistant, connect, idle } from './support/app.js';

const wanted = (process.env.ALP_WEB_E2E_REAL_RUNTIMES ?? '').split(',').map(name => name.trim()).filter(name => name === 'codex' || name === 'claude');
const MODELS = { codex: process.env.ALP_REAL_CODEX_MODEL ?? 'codex:gpt-6-luna', claude: process.env.ALP_REAL_CLAUDE_MODEL ?? 'claude:claude-haiku-4-5' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => createHash('sha512').update(bytes).digest('hex');
/** The installed runtimes, through a command of the root package (apps/web imports no runtime package). */
const NATIVE = fileURLToPath(new URL('../../../test/e2e/native-threads.mjs', import.meta.url));
const native = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [NATIVE, ...args], { env: { ...process.env, ALP_HOME: world.home } })).stdout);

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
      const usage = await native('usage', 'codex');
      await log({ step: 'codex.usage', ...usage });
      test.skip(!usage.ok, 'Codex usage is at or below 10% remaining (or unknown)');
    }
    const title = `Real ${runtime} files`;
    const { session } = await owner.request('session.create', { spec: { cwd: world.projects.main, persist: true, model: MODELS[runtime], mode: 'read-only', thinking: 'low' } });
    await owner.request('session.rename', { sessionId: session.id, title });
    await log({ step: 'create', runtime, sessionId: session.id, model: MODELS[runtime], promptAttachments: session.promptAttachments });
    try {
    expect(session.promptAttachments).toEqual(['file.path']);

    await connect(page, world, world.tokens.fileWriter);
    await page.getByRole('button', { name: title }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();

    const nonce = randomBytes(4).toString('hex');
    const word = `plum${randomBytes(3).toString('hex')}`;
    const binary = Buffer.concat([Buffer.from([0, 0xff, 0, 0x7f]), randomBytes(1500), Buffer.from([0])]);
    const offset = randomInt(16, binary.length - 16);
    const marker = binary.subarray(offset, offset + 8).toString('hex');
    const text = Buffer.from(`Attached from the browser.\nThe secret word is ${word}.\n`);
    const files = [{ name: `blob-${nonce}.bin`, bytes: binary }, { name: `notes-${nonce}.txt`, bytes: text }];
    await dropFiles(page, [{ name: files[0].name, type: 'application/octet-stream', buffer: binary }]);
    await page.getByTestId('composer-attach-input').setInputFiles([{ name: files[1].name, mimeType: 'text/plain', buffer: text }]);
    await expect(page.getByTestId('composer-file')).toHaveCount(2);
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill(`Use your shell tool on each attached file: compute its SHA-512 (shasum -a 512 or sha512sum) and its size in bytes (wc -c), and read the .txt file. Also print the 8 bytes at offset ${offset} of the .bin file as hex (xxd -s ${offset} -l 8 -p, or od). Reply with one line per file, exactly \`<file name> <sha512> <bytes>\`, then \`HEX <the 16 hex digits>\`, then \`WORD <the secret word>\`. Run the tools; do not guess.`);
    await composer.press('Enter');
    await expect(page.getByTestId('user-message-file')).toHaveCount(2, { timeout: 60_000 });
    const reply = assistant(page).last();
    for (const file of files) await expect(reply).toContainText(sha512(file.bytes), { timeout: 300_000 });
    await idle(page);
    const answer = await reply.innerText();
    await log({ step: 'reply', runtime, answer, expected: files.map(file => ({ name: file.name, sha512: sha512(file.bytes), sha256: sha256(file.bytes), bytes: file.bytes.length })), offset, marker, word });
    for (const file of files) expect(answer).toContain(String(file.bytes.length));
    expect(answer.toLowerCase().replace(/\s+/g, '')).toContain(marker);
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
    } finally {
      // Whatever happened, the native thread goes: the user's real Codex and Claude histories keep nothing of this test.
      const { threadId } = (await owner.request('session.get', { sessionId: session.id }).catch(() => ({ session: {} }))).session;
      await owner.request('session.close', { sessionId: session.id }).catch(() => {});
      if (threadId) await log({ step: 'cleanup', runtime, threadId, ...(await native('delete', runtime, threadId).catch(error => ({ deleted: false, error: error.message }))) });
    }
  });
}
