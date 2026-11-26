// The Claude side of fork and rewind (§12.7), through the real Agent SDK and a recording Claude Code
// stand-in: turn ids are the prompt uuids, a resume with a base forks only while the session has no
// transcript, and refusals fail the resume itself. Transcripts live in a temporary CLAUDE_CONFIG_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeTransport } from '@anhlp/alp-runtime';

const directory = await mkdtemp(path.join(tmpdir(), 'alp-claude-fork-'));
// The SDK reads transcripts in this process; nothing here touches the user's ~/.claude.
process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude');
const cwd = path.join(directory, 'project');
await mkdir(cwd, { recursive: true });
test.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const CLI = fileURLToPath(new URL('./support/recording-claude.js', import.meta.url));

/** Writes a transcript of `entries` ([type, uuid, content]) under another project's directory, as a session resumed from elsewhere. */
async function transcript(sessionId, entries, project = '-elsewhere') {
  const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', project);
  await mkdir(folder, { recursive: true });
  let parentUuid = null;
  const lines = entries.map(([type, uuid, content]) => {
    const line = { type, uuid, parentUuid, isSidechain: false, sessionId, cwd, timestamp: new Date().toISOString(),
      message: type === 'user' ? { role: 'user', content } : { role: 'assistant', type: 'message', id: `m-${uuid}`, model: 'fixture', content } };
    parentUuid = uuid;
    return JSON.stringify(line);
  });
  await writeFile(path.join(folder, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

const S = randomUUID();
const ids = { p1: randomUUID(), a1: randomUUID(), p2: randomUUID(), a2: randomUUID(), r2: randomUUID(), a2b: randomUUID() };
await transcript(S, [
  ['user', ids.p1, 'Remember ALPHA'], ['assistant', ids.a1, [{ type: 'text', text: 'OK' }]],
  ['user', ids.p2, [{ type: 'text', text: 'Run echo' }]], ['assistant', ids.a2, [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'echo' } }]],
  ['user', ids.r2, [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'probe' }]], ['assistant', ids.a2b, [{ type: 'text', text: 'probe' }]],
]);

const config = { cwd, model: 'sonnet', thinking: 'high', sandbox: 'workspace-write', approvalPolicy: 'never', developerInstructions: 'You are a fixture.', mcpServers: {}, dynamicTools: [] };

async function claude(t, extra = {}) {
  const record = path.join(directory, `record-${randomUUID()}.jsonl`);
  const transport = new ClaudeTransport(CLI, cwd, { ...process.env, ALP_FAKE_CLAUDE_RECORD: record, ...extra });
  t.after(() => transport.close());
  const seen = [];
  transport.onNotification((method, params) => seen.push({ method, ...params }));
  const recorded = async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { transport, seen, recorded };
}

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected condition did not arrive');
}

/** A flag's value as the SDK passes it (`--name=value` or `--name value`), true for a bare flag. */
const flag = (argv, name) => {
  const index = argv.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index] !== name) return argv[index].slice(name.length + 1);
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};

test('the transcript chain carries tool results, found under another project too', async t => {
  const { transport } = await claude(t);
  const { entries } = await transport.request('thread/chain', { threadId: S, cwd });
  assert.deepEqual(entries, [
    { uuid: ids.p1, type: 'user' }, { uuid: ids.a1, type: 'assistant' },
    { uuid: ids.p2, type: 'user' }, { uuid: ids.a2, type: 'assistant' }, { uuid: ids.r2, type: 'user', toolResult: true }, { uuid: ids.a2b, type: 'assistant' },
  ]);
  assert.deepEqual((await transport.request('thread/chain', { threadId: randomUUID(), cwd })).entries, []);
});

test('a resume with a base forks the base at its cut under the session id, and a turn id is its prompt uuid', async t => {
  const { transport, seen, recorded } = await claude(t);
  const N = randomUUID();
  const opened = await transport.request('thread/resume', { ...config, threadId: N, base: { threadId: S, at: ids.a1 } });
  assert.equal(opened.thread.id, N);
  await until(async () => (await recorded()).length);
  const [{ argv }] = await recorded();
  assert.equal(flag(argv, '--resume'), S);
  assert.equal(flag(argv, '--fork-session'), true);
  assert.equal(flag(argv, '--session-id'), N);
  assert.equal(flag(argv, '--resume-session-at'), ids.a1);
  assert.equal(flag(argv, '--resume-drops-turn'), undefined, 'ALP validates the cut itself');

  const { turn } = await transport.request('turn/start', { threadId: N, input: [{ type: 'text', text: 'go' }] });
  await until(async () => (await recorded()).some(entry => entry.prompt));
  assert.deepEqual((await recorded()).filter(entry => entry.prompt), [{ prompt: turn.id, session: N }]);
  await until(() => seen.some(event => event.method === 'turn/completed' && event.turn.id === turn.id));
});

test('a steer keeps its own uuid, and a fresh session gives its turns their prompt uuids too', async t => {
  const { transport, seen, recorded } = await claude(t);
  const { thread } = await transport.request('thread/start', { ...config });
  const { turn } = await transport.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'one' }] });
  await until(() => seen.some(event => event.method === 'turn/completed'));
  const { turn: second } = await transport.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'two' }] });
  await transport.request('turn/steer', { threadId: thread.id, expectedTurnId: second.id, input: [{ type: 'text', text: 'also' }] });
  await until(async () => (await recorded()).filter(entry => entry.prompt).length === 3);
  const prompts = (await recorded()).filter(entry => entry.prompt).map(entry => entry.prompt);
  assert.deepEqual(prompts.slice(0, 2), [turn.id, second.id]);
  assert.ok(![turn.id, second.id].includes(prompts[2]));
  const [{ argv }] = await recorded();
  assert.equal(flag(argv, '--fork-session'), undefined);
  assert.equal(flag(argv, '--session-id'), thread.id);
});

test('a session whose first prompt made it resumes itself, not its base', async t => {
  const N = randomUUID();
  await transcript(N, [['user', ids.p1, 'Remember ALPHA'], ['assistant', ids.a1, [{ type: 'text', text: 'OK' }]], ['user', randomUUID(), 'next']], '-forked');
  const { transport, recorded } = await claude(t);
  await transport.request('thread/resume', { ...config, threadId: N, base: { threadId: S, at: ids.a1 } });
  await until(async () => (await recorded()).length);
  const [{ argv }] = await recorded();
  assert.equal(flag(argv, '--resume'), N);
  assert.equal(flag(argv, '--fork-session'), undefined);
  assert.equal(flag(argv, '--resume-session-at'), undefined);
});

test('a missing base, cut point or required transcript fails the resume before Claude starts', async t => {
  const { transport: one, recorded: none1 } = await claude(t);
  await assert.rejects(one.request('thread/resume', { ...config, threadId: randomUUID(), base: { threadId: randomUUID() } }), /not found/);
  const { transport: two, recorded: none2 } = await claude(t);
  await assert.rejects(two.request('thread/resume', { ...config, threadId: randomUUID(), base: { threadId: S, at: randomUUID() } }), /has no entry/);
  const { transport: three, recorded: none3 } = await claude(t);
  await assert.rejects(three.request('thread/resume', { ...config, threadId: randomUUID(), requireHistory: true }), /not found/);
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const recorded of [none1, none2, none3]) assert.deepEqual(await recorded(), [], 'no Claude process started');
  // With its transcript, a required resume opens.
  const { transport: four, recorded } = await claude(t);
  await four.request('thread/resume', { ...config, threadId: S, requireHistory: true });
  await until(async () => (await recorded()).length);
  assert.equal(flag((await recorded())[0].argv, '--resume'), S);
});

test('Claude refusing the resume at boot fails the resume itself', async t => {
  const refusal = 'Resume rejected: Session not found in project directory';
  const { transport } = await claude(t, { ALP_FAKE_CLAUDE_REFUSE: refusal });
  const failures = [];
  transport.onFailure(error => failures.push(error));
  await assert.rejects(transport.request('thread/resume', { ...config, threadId: randomUUID(), base: { threadId: S, at: ids.a1 } }), error => error.message.includes(refusal));
  const { transport: plain } = await claude(t, { ALP_FAKE_CLAUDE_REFUSE: refusal });
  await assert.rejects(plain.request('thread/resume', { ...config, threadId: S, requireHistory: true }), error => error.message.includes(refusal));
});
