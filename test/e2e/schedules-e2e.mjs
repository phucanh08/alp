// Opt-in real-provider acceptance: a disposable main goes idle, then alpd wakes the
// same session without a client prompt. Never uses an existing ALP_HOME/session.
// Build first: node scripts/build-workspace.mjs cli
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';

const directory = await mkdtemp(path.join(tmpdir(), 'alp-real-scheduler-'));
const home = path.join(directory, 'home'), project = path.join(directory, 'project');
const token = `SCHEDULER_${randomUUID()}`;
const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-6.1-sol';
const delayMs = Number(process.env.ALP_SCHEDULE_E2E_DELAY_MS ?? 125000);
assert.ok(Number.isFinite(delayMs) && delayMs >= 1000);
await mkdir(home, { mode: 0o700 });
await initProject(project);
const settingsFile = path.join(project, '.alp/settings.json');
const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
settings.workflow = { ...settings.workflow, mode: 'pho', supervisor: false };
settings.team.pho.main = { profiles: [`${model}:low`] };
settings.team.pho.peer = { profiles: [`${model}:low`] };
await writeFile(settingsFile, JSON.stringify(settings));
const env = { ...process.env, ALP_HOME: home };
const daemon = spawn(process.execPath, [fileURLToPath(new URL('../../packages/daemon/dist/alpd.js', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(daemon, 'exit');
let diagnostics = '';
daemon.stdout.on('data', chunk => { diagnostics += chunk; });
daemon.stderr.on('data', chunk => { diagnostics += chunk; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}; daemon diagnostics: ${diagnostics.slice(-2000)}`);
}
const cli = (...args) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url)), 'schedule', ...args, '--project', project, '--json'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
let client;
const events = [];
try {
  await until(async () => { const lock = await readLock(home); return lock?.ready && lock.pid === daemon.pid; }, 'isolated daemon readiness', 30000);
  client = await connect((await readLock(home)).socket, { name: 'real-scheduler-e2e', version: '1' });
  client.onEvent(event => events.push(event));
  const { session } = await client.request('session.create', { spec: { cwd: project, persist: true, model, thinking: 'low', mode: 'read-only' } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'setup-only', content: [{ type: 'text', text: 'Harmless scheduler acceptance setup. Reply exactly READY and end this turn. Do not use tools or delegate.' }] });
  await until(() => events.some(envelope => envelope.sessionId === session.id && envelope.event.type === 'turn.ended'), 'initial main turn ended');
  assert.equal((await client.request('session.get', { sessionId: session.id })).session.status, 'idle');
  const dueAt = new Date(Date.now() + delayMs).toISOString();
  const prompt = `Harmless quota-reset continuation acceptance. First inspect the fresh runtime catalog and usage snapshot supplied to this turn and explicitly state whether availability is verified, denied, or unknown (missing data means unknown). Do not assume the scheduled time guarantees quota. Before any delegation, first emit a brief commentary with your availability marker and the actual fresh quota-window values you checked. Only if the snapshot explicitly verifies availability (known quota windows all below 100%, with no explicit denial or spend cap), delegate exactly one harmless read-only peer assignment (model ${model}, thinking low, wait true, modelReason harmless quota verification) asking it to reply QUOTA_CHECK_OK without tools and hand off complete. Wait for its result before ending. If availability is unknown or denied, do not delegate. Reply with ${token} and exactly one availability marker: AVAILABILITY_VERIFIED, AVAILABILITY_DENIED or AVAILABILITY_UNKNOWN, and explain the fresh evidence you checked. Do not run commands or change files.`;
  // CLI create/list/show/cancel are exercised against the actual isolated daemon.
  const cancelled = cli('create', '--session', session.id, '--at', dueAt, '--prompt', 'Must never execute').job;
  assert.equal(cli('cancel', cancelled.id).job.status, 'cancelled');
  const { job } = cli('create', '--session', session.id, '--at', dueAt, '--prompt', prompt);
  assert.ok(cli('list').jobs.some(entry => entry.id === job.id));
  assert.equal(cli('show', job.id).job.sessionId, session.id);
  const boundary = events.length;
  console.log(JSON.stringify({ phase: 'idle_wait', sessionId: session.id, jobId: job.id, dueAt, delayMs, home }));
  // No session.prompt or session.message after this boundary. The client only observes.
  await until(() => events.slice(boundary).some(envelope => envelope.sessionId === session.id && envelope.event.type === 'turn.started'), 'scheduled same-session turn started', delayMs + 180000);
  // Independently read the same account-free provider usage seam at wake time.
  // The runtime's per-turn snapshot injection is separately covered by daemon tests.
  const usage = await client.request('daemon.usage', { refresh: true });
  const quota = usage.providers.find(provider => provider.runtime === model.split(':')[0]);
  const known = quota?.windows.filter(window => typeof window.usedPercent === 'number') ?? [];
  const expectedAvailability = quota?.limited ? 'DENIED' : quota?.available && known.length ? 'VERIFIED' : 'UNKNOWN';
  await until(() => events.slice(boundary).some(envelope => envelope.sessionId === session.id && envelope.event.type === 'turn.ended'), 'scheduled same-session turn ended', 180000);
  const after = cli('show', job.id).job;
  assert.equal(after.status, 'delivered', JSON.stringify(after));
  assert.equal(after.attempts, 1);
  const turns = events.slice(boundary).filter(envelope => envelope.event.type === 'turn.started' && envelope.sessionId === session.id);
  assert.ok(turns.length >= 1);
  assert.equal(turns[0].sessionId, session.id);
  const messages = new Map();
  for (const envelope of events.slice(boundary)) if (envelope.sessionId === session.id && envelope.event.type === 'item' && envelope.event.item.kind === 'assistant_message') messages.set(envelope.event.item.id, envelope.event.item.text);
  const output = [...messages.values()].join('\n');
  assert.ok(output.includes(token), output);
  const marker = `AVAILABILITY_${expectedAvailability}`;
  assert.ok(output.includes(marker), `Agent availability must match fresh provider evidence ${JSON.stringify(quota)}: ${output}`);
  const assignments = events.slice(boundary).filter(envelope => envelope.event.type === 'assignment');
  if (expectedAvailability !== 'VERIFIED') assert.equal(assignments.length, 0, 'unknown or denied availability must not delegate');
  else {
    assert.ok(assignments.length > 0, 'verified availability must reach the harmless peer assignment');
    const relevant = events.slice(boundary);
    const checked = relevant.findIndex(envelope => envelope.sessionId === session.id && envelope.event.type === 'item' && envelope.event.item.kind === 'assistant_message' && envelope.event.item.text.includes(marker));
    const delegated = relevant.findIndex(envelope => envelope.event.type === 'assignment');
    assert.ok(checked >= 0 && checked < delegated, 'agent reports actual availability before delegating');
    assert.ok(output.includes('QUOTA_CHECK_OK'), 'verified path includes the real harmless peer result');
  }
  const evidence = { passed: true, model, sessionId: session.id, job: after, output, quotaEvidence: quota, expectedAvailability, events, homeIsolated: true };
  const artifact = path.join(tmpdir(), `alp-schedules-e2e-${Date.now()}.json`);
  await writeFile(artifact, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, sessionId: session.id, job: after, output, artifact }));
} finally {
  if (client) { await client.request('daemon.shutdown').catch(() => {}); client.close(); }
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
  await exited;
  await rm(directory, { recursive: true, force: true });
}
