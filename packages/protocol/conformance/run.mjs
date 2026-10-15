#!/usr/bin/env node
// Conformance runner for ALP JSON-RPC v1 (docs/protocol/alp-json-rpc-v1.md §11).
//
//   node run.mjs --socket <path> [--profiles handshake,wire,errors,limits,session]
//                [--project <dir> --model <model> [--hold-marker <text>]] [--json]
//
// It speaks to a daemon over its newline-delimited stream endpoint (a Unix socket or a Windows
// named pipe) and imports nothing of any implementation: only node:net and the protocol's own
// schemas. The session profile creates sessions in --project and needs a provider whose turns
// end by themselves, except a prompt containing the hold marker, whose turn runs until interrupted.
// Run it against a disposable daemon home, never a user's real one.
import net from 'node:net';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { validateDefinition, validateResult } from '../src/contract.js';

const MAX_FRAME = 16 * 1024 * 1024;
const TIMEOUT = 10_000;
const CASES = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')).cases;
export const PROFILES = ['handshake', 'wire', 'errors', 'limits', 'session'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One connection: raw writes, every frame it receives, and waits on them. */
function open(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.setEncoding('utf8');
      const frames = [];
      const problems = [];
      let buffer = '';
      let closed = false;
      let notify = () => {};
      socket.on('data', chunk => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let frame;
          try { frame = JSON.parse(line); } catch { problems.push(`daemon sent a frame that is not JSON: ${line.slice(0, 200)}`); continue; }
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { problems.push('daemon sent an invalid frame: expected an object'); continue; }
          // Everything the daemon sends must be a v1 message: a response, an event or an extension.invoke.
          const issues = validateDefinition(frame.method === 'event' ? 'notification' : 'method' in frame ? 'request' : 'response', frame);
          if (issues.length) problems.push(`daemon sent an invalid ${frame.method ?? 'response'} frame: ${describe(issues)} in ${line.slice(0, 300)}`);
          frames.push(frame);
        }
        notify();
      });
      socket.on('error', () => {});
      socket.on('close', () => { closed = true; notify(); });
      const connection = {
        frames, problems,
        get closed() { return closed; },
        write(text) { socket.write(text); },
        send(value) { socket.write(`${JSON.stringify(value)}\n`); },
        /** Resolves with the first frame matching `test`, removing it; rejects on timeout or close. */
        async take(test, what, timeout = TIMEOUT) {
          const deadline = Date.now() + timeout;
          for (;;) {
            const index = frames.findIndex(test);
            if (index >= 0) return frames.splice(index, 1)[0];
            if (closed) throw new Error(`connection closed while waiting for ${what}`);
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`timed out waiting for ${what}`);
            await new Promise(wake => { const timer = setTimeout(wake, Math.min(left, 50)); notify = () => { clearTimeout(timer); wake(); }; });
          }
        },
        async request(method, params, id = randomUUID()) {
          connection.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
          const reply = await connection.take(frame => frame.id === id && !('method' in frame), `the answer to ${method}`);
          if (reply.result !== undefined) {
            const issues = validateResult(method, reply.result);
            if (issues?.length) problems.push(`${method} result does not match its schema: ${describe(issues)}`);
          }
          return reply;
        },
        events: () => frames.filter(frame => frame.method === 'event').map(frame => frame.params),
        drainEvents() { const taken = connection.events(); for (let i = frames.length - 1; i >= 0; i--) if (frames[i].method === 'event') frames.splice(i, 1); return taken; },
        async hello() {
          const reply = await connection.request('daemon.hello', { protocolVersion: 1, client: { name: 'alp-conformance', version: '1' } });
          if (reply.error) throw new Error(`daemon.hello failed: ${JSON.stringify(reply.error)}`);
          return reply.result;
        },
        close() { socket.destroy(); },
      };
      resolve(connection);
    });
  });
}

const describe = issues => issues.map(issue => `${issue.path || '/'} ${issue.message}`).join('; ');

/** Subset match: every expected property must match; {"$type"} matches a JSON type, {"$absent": true} an absent one. */
function mismatch(expected, actual, at = '') {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$absent' in expected) return actual === undefined ? undefined : `${at || '/'} should be absent`;
    if ('$type' in expected) {
      const type = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
      return type === expected.$type ? undefined : `${at || '/'} should be ${expected.$type}, is ${type}`;
    }
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${at || '/'} should be an object, is ${JSON.stringify(actual)}`;
    for (const [key, value] of Object.entries(expected)) {
      const problem = mismatch(value, actual[key], `${at}/${key}`);
      if (problem) return problem;
    }
    return undefined;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${at || '/'} should be ${JSON.stringify(expected)}, is ${JSON.stringify(actual)}`;
    for (let index = 0; index < expected.length; index++) {
      const problem = mismatch(expected[index], actual[index], `${at}/${index}`);
      if (problem) return problem;
    }
    return undefined;
  }
  return Object.is(expected, actual) ? undefined : `${at || '/'} should be ${JSON.stringify(expected)}, is ${JSON.stringify(actual)}`;
}

const usableId = id => (typeof id === 'string' && [...id].length <= 128) || Number.isSafeInteger(id);
const isAnswer = frame => !('method' in frame);

async function runCase(socketPath, testCase) {
  const connection = await open(socketPath);
  try {
    if (testCase.hello) await connection.hello();
    for (const step of testCase.steps) {
      if (step.probe) {
        // Registering the method now succeeds only if no earlier frame of this case registered it.
        const reply = await connection.request('extension.register', { method: step.probe });
        if (reply.error) throw new Error(`an earlier frame ran: registering ${step.probe} again failed with ${JSON.stringify(reply.error)}`);
        continue;
      }
      if (step.sendBytes) {
        const raw = JSON.stringify(step.send);
        const padding = step.sendBytes - Buffer.byteLength(raw, 'utf8') - 1;
        if (padding < 0) throw new Error('sendBytes is smaller than the request');
        connection.write(raw.slice(0, -1) + ' '.repeat(padding) + '}\n');
      } else if (step.sendOversized) {
        // One frame of that many bytes before its newline, written in pieces, never finished.
        const piece = 'x'.repeat(1024 * 1024);
        connection.write(`{"jsonrpc":"2.0","id":1,"method":"catalog.get","params":{"pad":"`);
        for (let sent = 0; sent < step.sendOversized && !connection.closed; sent += piece.length) { connection.write(piece); await sleep(1); }
      } else if ('sendRaw' in step) connection.write(step.sendRaw);
      else connection.send(step.send);
      if (step.expectClose) {
        const deadline = Date.now() + 3 * TIMEOUT;
        while (!connection.closed && Date.now() < deadline) await sleep(20);
        if (!connection.closed) throw new Error('the daemon kept the connection open');
        if (connection.frames.some(isAnswer)) throw new Error(`the daemon answered before closing: ${JSON.stringify(connection.frames.find(isAnswer)).slice(0, 200)}`);
        continue;
      }
      if (step.expectNone !== undefined) {
        await sleep(step.expectNone);
        const answer = connection.frames.find(isAnswer);
        if (answer) throw new Error(`expected no answer, got ${JSON.stringify(answer).slice(0, 300)}`);
        continue;
      }
      if (step.expectIds) {
        for (const [id, expected] of Object.entries(step.expectIds)) {
          const frame = await connection.take(candidate => isAnswer(candidate) && candidate.id === id, `the answer with id ${id}`);
          const problem = mismatch(expected, frame);
          if (problem) throw new Error(`answer ${id}: ${problem}: ${JSON.stringify(frame).slice(0, 300)}`);
        }
        continue;
      }
      const sentId = step.send && typeof step.send === 'object' && !Array.isArray(step.send) ? step.send.id : undefined;
      const frame = await connection.take(candidate => isAnswer(candidate) && (usableId(sentId) && step.expect.id !== null ? candidate.id === sentId : true), 'an answer');
      const problem = mismatch(step.expect, frame);
      if (problem) throw new Error(`${problem}: ${JSON.stringify(frame).slice(0, 400)}`);
      if (frame.result !== undefined && step.send?.method) {
        const issues = validateResult(step.send.method, frame.result);
        if (issues?.length) throw new Error(`${step.send.method} result does not match its schema: ${describe(issues)}`);
      }
    }
    await sleep(50);
    if (connection.frames.some(isAnswer)) throw new Error('daemon sent an unexpected or duplicate response');
    if (connection.problems.length) throw new Error(connection.problems.join('\n'));
  } finally {
    connection.close();
  }
}

/** Session scenarios: lifecycle events, cursor replay, reset, idempotent prompts, cancellation (§8–§9). */
function sessionScenarios({ project, model, hold }) {
  const spec = { cwd: project, persist: true, ...(model ? { model } : {}) };
  const text = body => [{ type: 'text', text: body }];
  const kept = events => events.filter(envelope => envelope.cursor !== undefined);
  const until = async (connection, test, what, timeout = TIMEOUT) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = connection.events().find(test);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  };
  const turnEnded = (connection, sessionId) => until(connection, envelope => envelope.sessionId === sessionId && envelope.event.type === 'turn.ended', 'turn.ended');
  /** Cursors of kept envelopes rise strictly; seq rises per session and epoch. */
  function ordered(events) {
    let cursor = 0;
    const seqs = new Map();
    for (const envelope of kept(events)) {
      if (envelope.cursor <= cursor) throw new Error(`cursor ${envelope.cursor} after ${cursor}`);
      cursor = envelope.cursor;
      const key = `${envelope.sessionId}\u0000${envelope.epoch}`;
      if (envelope.seq <= (seqs.get(key) ?? -1)) throw new Error(`seq ${envelope.seq} of ${envelope.sessionId} did not rise`);
      seqs.set(key, envelope.seq);
    }
  }
  async function created(connection) {
    const capabilities = (await connection.hello()).capabilities ?? [];
    const sessionId = `conf_${randomUUID().slice(0, 12)}`;
    const reply = await connection.request('session.create', { sessionId, spec });
    if (reply.error) throw new Error(`session.create failed: ${JSON.stringify(reply.error)}`);
    if (reply.result.attached !== false) throw new Error('a new session answered attached');
    await until(connection, envelope => envelope.sessionId === sessionId && envelope.event.type === 'session.ready', 'session.ready');
    return { sessionId, capabilities };
  }
  const prompt = (connection, sessionId, body, clientMessageId = randomUUID(), delivery = 'auto') =>
    connection.request('session.prompt', { sessionId, clientMessageId, delivery, content: text(body) });

  return [
    ['session.lifecycle', 'create opens the session with session.opened then session.ready; a prompt is accepted, starts and ends a turn; every envelope validates and cursors rise', async connection => {
      const { sessionId } = await created(connection);
      const initial = connection.events().filter(envelope => envelope.sessionId === sessionId);
      const opened = initial.find(envelope => envelope.event.type === 'session.opened');
      if (initial.findIndex(envelope => envelope.event.type === 'session.opened') >= initial.findIndex(envelope => envelope.event.type === 'session.ready')) throw new Error('session.opened must precede session.ready');
      if (!opened || opened.sessionId !== sessionId) throw new Error('no session.opened for the new session');
      const reply = await prompt(connection, sessionId, 'conformance hello');
      if (reply.error) throw new Error(`session.prompt failed: ${JSON.stringify(reply.error)}`);
      const ended = await turnEnded(connection, sessionId);
      if (ended.event.state !== 'completed') throw new Error(`turn ended ${ended.event.state}`);
      const types = connection.events().filter(envelope => envelope.sessionId === sessionId).map(envelope => envelope.event.type);
      for (const type of ['prompt.accepted', 'turn.started', 'turn.ended']) if (!types.includes(type)) throw new Error(`no ${type} event`);
      if (types.indexOf('turn.started') > types.indexOf('turn.ended')) throw new Error('turn.ended before turn.started');
      ordered(connection.events());
    }],
    ['session.replay-after', 'attach { after } replays exactly the kept events after the cursor, in order, and answers the tip; after = tip replays nothing', async (connection, socketPath) => {
      const { sessionId, capabilities } = await created(connection);
      if (!capabilities.includes('attach.after')) return 'skipped: attach.after not advertised';
      await prompt(connection, sessionId, 'conformance replay');
      await turnEnded(connection, sessionId);
      const seen = kept(connection.events());
      const middle = seen[Math.floor(seen.length / 2)].cursor;
      const other = await open(socketPath);
      try {
        await other.hello();
        const reply = await other.request('session.attach', { sessionId, after: middle });
        if (reply.error) throw new Error(`session.attach failed: ${JSON.stringify(reply.error)}`);
        if (reply.result.reset) throw new Error('a cursor the tree reached answered reset');
        const tip = seen.at(-1).cursor;
        if (reply.result.cursor < tip) throw new Error(`attach answered cursor ${reply.result.cursor} below ${tip}`);
        const replayed = kept(other.drainEvents()).filter(envelope => envelope.cursor <= reply.result.cursor);
        if (reply.result.cursor > tip) await until(connection, envelope => envelope.cursor >= reply.result.cursor, 'the attach tip on the original connection');
        const want = kept(connection.events()).filter(envelope => envelope.cursor > middle && envelope.cursor <= reply.result.cursor && !envelope.event.type.startsWith('question')).map(envelope => envelope.cursor);
        const got = replayed.map(envelope => envelope.cursor);
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`replayed cursors ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        const again = await other.request('session.attach', { sessionId, after: reply.result.cursor });
        if (again.error || again.result.reset) throw new Error(`attach at the tip failed: ${JSON.stringify(again)}`);
        if (kept(other.drainEvents()).some(envelope => envelope.cursor <= reply.result.cursor)) throw new Error('attach at the tip replayed events');
        if (other.problems.length) throw new Error(other.problems.join('\n'));
      } finally { other.close(); if (other.problems.length) throw new Error(other.problems.join('\n')); }
    }],
    ['session.replay-reset', 'attach with a cursor beyond the tip answers reset: true and replays the timeline from its start', async (connection, socketPath) => {
      const { sessionId, capabilities } = await created(connection);
      if (!capabilities.includes('attach.after')) return 'skipped: attach.after not advertised';
      const other = await open(socketPath);
      try {
        await other.hello();
        const reply = await other.request('session.attach', { sessionId, after: 9_000_000_000_000 });
        if (reply.error) throw new Error(`session.attach failed: ${JSON.stringify(reply.error)}`);
        if (reply.result.reset !== true) throw new Error('a cursor beyond the tip did not answer reset');
        const replayed = kept(other.drainEvents()).filter(envelope => envelope.cursor <= reply.result.cursor);
        if (reply.result.cursor > kept(connection.events()).at(-1).cursor) await until(connection, envelope => envelope.cursor >= reply.result.cursor, 'the reset tip');
        const want = kept(connection.events()).filter(envelope => envelope.cursor <= reply.result.cursor && !envelope.event.type.startsWith('question')).map(envelope => envelope.cursor);
        if (JSON.stringify(replayed.map(envelope => envelope.cursor)) !== JSON.stringify(want)) throw new Error('the reset replay did not contain the full kept timeline');
        ordered(replayed);
      } finally { other.close(); if (other.problems.length) throw new Error(other.problems.join('\n')); }
    }],
    ['session.live-after-replay', 'events after an attach arrive after its replay with higher cursors, never duplicated', async (connection, socketPath) => {
      const { sessionId, capabilities } = await created(connection);
      if (!capabilities.includes('attach.after')) return 'skipped: attach.after not advertised';
      const other = await open(socketPath);
      try {
        await other.hello();
        const attach = await other.request('session.attach', { sessionId, after: 0 });
        await prompt(connection, sessionId, 'conformance live');
        await turnEnded(other, sessionId);
        const cursors = kept(other.events()).map(envelope => envelope.cursor);
        if (new Set(cursors).size !== cursors.length) throw new Error('an event arrived twice');
        ordered(other.events());
        if (!kept(other.events()).some(envelope => envelope.cursor > attach.result.cursor)) throw new Error('no live event after the attach');
      } finally { other.close(); if (other.problems.length) throw new Error(other.problems.join('\n')); }
    }],
    ['session.prompt-idempotent', 'a repeated clientMessageId answers the first outcome without a second turn; other content with it is a 1004 key_conflict', async connection => {
      const { sessionId, capabilities } = await created(connection);
      if (!capabilities.includes('prompt.receipts')) return 'skipped: prompt.receipts not advertised';
      const id = randomUUID();
      const first = await prompt(connection, sessionId, 'conformance once', id);
      if (first.error || first.result.outcome !== 'accepted') throw new Error(`first prompt: ${JSON.stringify(first)}`);
      await turnEnded(connection, sessionId);
      const repeat = await prompt(connection, sessionId, 'conformance once', id);
      if (repeat.error || repeat.result.duplicate !== true || repeat.result.outcome !== 'accepted') throw new Error(`repeat: ${JSON.stringify(repeat)}`);
      const conflict = await prompt(connection, sessionId, 'conformance other', id);
      if (conflict.error?.code !== 1004 || conflict.error.data?.reason !== 'key_conflict') throw new Error(`other content: ${JSON.stringify(conflict)}`);
      await sleep(200);
      const accepted = connection.events().filter(envelope => envelope.event.type === 'prompt.accepted' && envelope.event.clientMessageId === id);
      if (accepted.length !== 1) throw new Error(`${accepted.length} prompt.accepted events for one clientMessageId`);
    }],
    ['session.invalid-prompt-no-effect', 'a prompt with invalid params is refused before any receipt or turn: the same clientMessageId then goes through as a first delivery', async connection => {
      const { sessionId } = await created(connection);
      const id = randomUUID();
      const bad = await connection.request('session.prompt', { sessionId, clientMessageId: id, content: 'not an array' });
      if (bad.error?.code !== -32602) throw new Error(`invalid prompt answered ${JSON.stringify(bad)}`);
      const good = await prompt(connection, sessionId, 'conformance after invalid', id);
      if (good.error || good.result.duplicate) throw new Error(`valid prompt after the invalid one: ${JSON.stringify(good)}`);
      await turnEnded(connection, sessionId);
    }],
    ['session.interrupt', 'session.interrupt cancels the running turn: turn.ended with state canceled; the request answers before or after it, either is valid', async connection => {
      const { sessionId } = await created(connection);
      if (!hold) return 'skipped: no --hold-marker';
      await prompt(connection, sessionId, `conformance ${hold}`);
      await until(connection, envelope => envelope.sessionId === sessionId && envelope.event.type === 'turn.started', 'turn.started');
      const reply = await connection.request('session.interrupt', { sessionId });
      if (reply.error) throw new Error(`session.interrupt failed: ${JSON.stringify(reply.error)}`);
      const ended = await turnEnded(connection, sessionId);
      if (ended.event.state !== 'canceled') throw new Error(`turn ended ${ended.event.state}, expected canceled`);
    }],
    ['session.unicode', 'titles round-trip Unicode exactly; the 200-character limit counts code points', async connection => {
      const { sessionId } = await created(connection);
      const title = 'Phở ☕ 😀 \u{1F468}‍\u{1F469}';
      const renamed = await connection.request('session.rename', { sessionId, title });
      if (renamed.error || renamed.result.session.title !== title) throw new Error(`rename: ${JSON.stringify(renamed)}`);
      const astral = await connection.request('session.rename', { sessionId, title: '😀'.repeat(200) });
      if (astral.error) throw new Error(`200 astral code points were refused: ${JSON.stringify(astral.error)}`);
      const over = await connection.request('session.rename', { sessionId, title: '😀'.repeat(201) });
      if (over.error?.code !== -32602) throw new Error(`201 code points answered ${JSON.stringify(over)}`);
    }],
    ['session.release-and-close', 'release answers whether the idle root closed; otherwise close makes session.get report closed', async connection => {
      const { sessionId } = await created(connection);
      const released = await connection.request('session.release', { sessionId });
      if (released.error || typeof released.result.closed !== 'boolean') throw new Error(`release: ${JSON.stringify(released)}`);
      if (!released.result.closed) {
        const closed = await connection.request('session.close', { sessionId });
        if (closed.error) throw new Error(`close: ${JSON.stringify(closed.error)}`);
      }
      const listed = await connection.request('session.get', { sessionId });
      if (listed.error || listed.result.session.status !== 'closed') throw new Error(`after close: ${JSON.stringify(listed)}`);
    }],
  ];
}

export async function runConformance({ socket, profiles = PROFILES.filter(name => name !== 'session'), project, model, hold }) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(name => !PROFILES.includes(name))) throw new Error(`Select known profiles: ${PROFILES.join(', ')}`);
  if (profiles.includes('session') && !project) throw new Error('the session profile needs --project');
  const results = [];
  for (const testCase of CASES.filter(candidate => profiles.includes(candidate.profile))) {
    try { await runCase(socket, testCase); results.push({ id: testCase.id, ok: true }); }
    catch (error) { results.push({ id: testCase.id, ok: false, error: error.message }); }
  }
  if (profiles.includes('session')) {
    for (const [id, , scenario] of sessionScenarios({ project, model, hold })) {
      let connection;
      try {
        connection = await open(socket);
        const note = await scenario(connection, socket);
        if (connection.problems.length) throw new Error(connection.problems.join('\n'));
        results.push({ id, ok: true, ...(note ? { note } : {}) });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      } finally { connection?.close(); }
    }
  }
  return results;
}

/** The scenario ids and descriptions, for documentation and tests. */
export const SESSION_SCENARIOS = sessionScenarios({}).map(([id, description]) => ({ id, description }));
export { CASES };

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMain()) {
  const { values } = parseArgs({ options: { socket: { type: 'string' }, profiles: { type: 'string' }, project: { type: 'string' }, model: { type: 'string' }, 'hold-marker': { type: 'string' }, json: { type: 'boolean' } } });
  if (!values.socket) { console.error('Usage: run.mjs --socket <path> [--profiles a,b] [--project <dir> --model <model> --hold-marker <text>] [--json]'); process.exit(2); }
  const profiles = values.profiles ? values.profiles.split(',').map(name => name.trim()) : undefined;
  const results = await runConformance({ socket: values.socket, profiles, project: values.project, model: values.model, hold: values['hold-marker'] });
  if (values.json) console.log(JSON.stringify(results, null, 2));
  else for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id}${result.note ? ` (${result.note})` : ''}${result.error ? `\n     ${result.error.replaceAll('\n', '\n     ')}` : ''}`);
  const failed = results.filter(result => !result.ok).length;
  console.error(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
