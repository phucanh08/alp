#!/usr/bin/env node
// Runs only from an isolated install of the six neutral core tarballs (copied there by
// scripts/core-standalone-smoke.mjs next to a copy of the deterministic fake ACP agent).
//
//   Part A: the installed in-process runtime opens an ACP session on the fake agent, performs the
//           ACP handshake, and streams a prompt — no plugin, no real credentials.
//   Part B: the installed alpd serves a real unix socket with the integration absent; an ACP session
//           runs over it, a client disconnects, and a reconnect replays the still-busy session
//           before a clean shutdown.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initProject } from '@anhlp/alp-core/init';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { ensureDaemon, connect, readLock } from '@anhlp/alp-client';

const FAKE = path.join(import.meta.dirname, 'fake-acp.js');
const ALPD_ENTRY = path.join(import.meta.dirname, 'node_modules/@anhlp/alp-daemon/dist/alpd.js');
const work = await mkdtemp(path.join(tmpdir(), 'alp-standalone-'));
const project = path.join(work, 'project');
const homeA = path.join(work, 'home-a');
const homeB = path.join(work, 'home-b');
const logA = path.join(work, 'acp-a.jsonl');
const logB = path.join(work, 'acp-b.jsonl');
const settings = { defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false } };

const until = async (check, what, tries = 3000) => {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};
const log = async file => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const provider = logFile => ({ kind: 'acp', label: 'Fake', command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: logFile } });
const assistantText = (events, sessionId, from) => events.slice(from).filter(entry => entry.sessionId === sessionId && entry.event.type === 'item' && entry.event.item?.kind === 'assistant_message').map(entry => entry.event.item.text);
const cleanup = () => rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

try {
  await initProject(project);
  await writeFile(path.join(project, '.alp', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);

  // Part A — in-process runtime from the installed tarball.
  await saveEntry('providers', 'fake', { provider: provider(logA) }, { scope: 'library', library: homeA });
  const runtime = createAlpRuntime({ language: 'English', supervisor: false, libraryDir: homeA, runLogDir: path.join(work, 'runs') });
  const runtimeEvents = [];
  runtime.onEvent(entry => runtimeEvents.push(entry));
  const opened = await runtime.open('root', { cwd: project, model: 'acp:fake' });
  assert.equal(opened.runtime, 'acp', 'Part A opens an ACP runtime');
  const start = runtimeEvents.length;
  await runtime.prompt('root', { clientMessageId: 'a1', delivery: 'auto', content: [{ type: 'text', text: 'fake:say part-a-ok' }] });
  await until(() => runtimeEvents.slice(start).some(entry => entry.sessionId === 'root' && entry.event.type === 'turn.ended'), 'the Part A turn');
  assert.equal(assistantText(runtimeEvents, 'root', start).at(-1), 'part-a-ok', 'Part A streams the prompt response');
  const handshake = await log(logA);
  const init = handshake.find(message => message.method === 'initialize');
  assert.ok(init, 'the fake agent received the ACP initialize');
  assert.equal(init.params.protocolVersion, 1, 'ACP handshake protocolVersion 1');
  await runtime.shutdown();
  console.log('PART_A_OK installed runtime: ACP handshake + prompt + stream');

  // Part B — installed alpd over a real unix socket, integration absent.
  await access(ALPD_ENTRY).catch(() => { throw new Error(`installed alpd missing: ${ALPD_ENTRY}`); });
  await saveEntry('providers', 'fake', { provider: provider(logB) }, { scope: 'library', library: homeB });
  const socket = await ensureDaemon({ home: homeB, entry: ALPD_ENTRY });
  const lock = await readLock(homeB);
  assert.equal(lock.ready, true, 'the installed alpd comes up ready');
  assert.equal(socket, lock.socket, 'the lock publishes the socket');
  await assert.rejects(access(path.join(homeB, 'integrations/web.json')), 'no integration descriptor exists at start');

  const client = await connect(socket);
  const events = [];
  client.onEvent(entry => events.push(entry));
  const status = await client.request('daemon.status');
  assert.equal(status.pid, lock.pid, 'IPC RPC answers with the daemon pid');
  const created = await client.request('session.create', { sessionId: 'root', spec: { cwd: project, model: 'acp:fake', persist: false } });
  assert.equal(created.session.id, 'root', 'the daemon opens the ACP session over IPC');
  await client.request('session.prompt', { sessionId: 'root', clientMessageId: 'm1', content: [{ type: 'text', text: 'fake:hang' }] });
  await until(() => events.some(entry => entry.sessionId === 'root' && entry.event.type === 'turn.started'), 'the busy turn over IPC');
  const handshakeB = await log(logB);
  assert.equal(handshakeB.find(message => message.method === 'initialize')?.params.protocolVersion, 1, 'the daemon-side ACP handshake is versioned');
  assert.ok(handshakeB.some(message => message.method === 'session/new'), 'the daemon-side ACP session was created');

  // Disconnect: the daemon keeps serving and its busy session stays.
  client.close();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await readLock(homeB)).ready, true, 'the daemon survives a client disconnect');

  // Reconnect and replay the still-busy session.
  const again = await connect(socket);
  const replayEvents = [];
  again.onEvent(entry => replayEvents.push(entry));
  const reopened = await again.request('session.create', { sessionId: 'root', spec: { cwd: project, model: 'acp:fake', persist: false }, history: 'replay' });
  assert.equal(reopened.attached, true, 'a reconnect replays the retained session');
  await until(() => replayEvents.some(entry => entry.sessionId === 'root' && entry.event.type === 'turn.started'), 'the replayed turn events');
  assert.equal((await again.request('session.list')).sessions.some(session => session.id === 'root'), true, 'session.list still lists it');

  await again.request('daemon.shutdown');
  again.close();
  await until(async () => !(await readLock(homeB)), 'the daemon lock to clear');
  await assert.rejects(connect(socket), 'a stopped daemon refuses connections');
  await assert.rejects(access(path.join(homeB, 'integrations/web.json')), 'the integration never appeared');
  console.log('PART_B_OK installed alpd: start(no integration) + RPC + ACP session + disconnect + replay + shutdown');
  console.log('STANDALONE_CORE_SMOKE_PASSED');
} finally {
  await cleanup();
}
