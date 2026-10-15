import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, readLogTail, redact, scrubText } from '../src/log.js';

const SECRETS = [
  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'AKIAABCDEFGHIJKLMNOP',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  'hunter2-very-secret',
];

const capture = options => {
  const lines = [];
  return { lines, log: createLogger({ component: 'test', write: line => lines.push(line), now: () => new Date('2026-10-15T00:00:00.000Z'), ...options }) };
};

test('a record is one JSON line with time, level, component, code, message and correlation ids', () => {
  const { lines, log } = capture();
  log.error('could not write', { code: 'ALP_PERSISTENCE_WRITE_FAILED', sessionId: 's1', rootId: 'r1', assignmentId: 'a1', clientMessageId: 'm1', requestId: 7, agent: 'peer', operation: 'record s1' });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n'));
  assert.deepEqual(JSON.parse(lines[0]), {
    time: '2026-10-15T00:00:00.000Z', level: 'error', component: 'test', code: 'ALP_PERSISTENCE_WRITE_FAILED', msg: 'could not write',
    sessionId: 's1', rootId: 'r1', assignmentId: 'a1', clientMessageId: 'm1', requestId: '7', agent: 'peer', operation: 'record s1',
  });
  // Children add ids and may rename the component; an error's own code names the failure.
  const child = log.child({ sessionId: 's2' }, 'test.child');
  child.warn('slow', { error: Object.assign(new Error('late'), { code: 'ETIMEDOUT' }) });
  const record = JSON.parse(lines[1]);
  assert.deepEqual([record.component, record.sessionId, record.code, record.error.message], ['test.child', 's2', 'ETIMEDOUT', 'late']);
});

test('records below the level are dropped; ALP_LOG_LEVEL sets the default', () => {
  const quiet = capture({ level: 'warn' });
  quiet.log.info('hidden');
  quiet.log.warn('shown');
  assert.equal(quiet.lines.length, 1);
  const env = capture({ env: { ALP_LOG_LEVEL: 'debug' } });
  env.log.debug('shown');
  assert.equal(env.lines.length, 1);
  const normal = capture({ env: {} });
  normal.log.debug('hidden');
  assert.equal(normal.lines.length, 0);
});

test('secrets, prompts and environments never reach a record, wherever they hide', () => {
  const { lines, log } = capture({ env: { PATH: '/bin', MY_SERVICE_TOKEN: 'plain-token-value-1234', HOME: '/home/me' } });
  log.error(`failed with ${SECRETS[0]} and Bearer abcdefghijklmnop and plain-token-value-1234`, {
    code: 'ALP_PROVIDER_FAILED',
    error: Object.assign(new Error(`login ${SECRETS[1]} rejected; OPENAI_API_KEY=${SECRETS[4]}`), { code: 'E_LOGIN' }),
    prompt: 'my private prompt', instructions: 'private instructions', env: { ANTHROPIC_API_KEY: SECRETS[0], PATH: '/bin' }, content: [{ type: 'text', text: 'private' }],
    headers: { authorization: `Bearer ${SECRETS[3]}` },
    nested: { password: SECRETS[4], apiKey: SECRETS[0], note: `aws ${SECRETS[2]} jwt ${SECRETS[3]}`, url: `https://user:${SECRETS[4]}@example.com/x` },
    list: [`--token ${SECRETS[1]}`, 'harmless'],
  });
  const text = lines.join('\n');
  for (const secret of [...SECRETS, 'plain-token-value-1234', 'my private prompt', 'private instructions']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  const record = JSON.parse(lines[0]);
  assert.equal(record.code, 'ALP_PROVIDER_FAILED');
  assert.equal(record.prompt, '[omitted]');
  assert.equal(record.env, '[omitted]');
  assert.equal(record.nested.password, '[redacted]');
  assert.equal(record.list[1], 'harmless');
  assert.match(record.error.message, /^login \[redacted\] rejected; OPENAI_API_KEY=\[redacted\]$/);
});

test('text that is not secret is left alone, and long text, cycles and depth are bounded', () => {
  assert.equal(scrubText('unknown key: workfow; limits.autoResume must be true or false'), 'unknown key: workfow; limits.autoResume must be true or false');
  assert.match(scrubText('x'.repeat(5000)), /\.\.\. \(3000 more characters\)$/);
  const cycle = { name: 'a' };
  cycle.self = cycle;
  assert.equal(redact(cycle).self, '[circular]');
  assert.equal(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } }).a.b.c.d.e, '[too deep]');
  // A sink that throws, or a value that cannot be read, never breaks the caller.
  const broken = createLogger({ component: 'test', write() { throw new Error('disk full'); } });
  assert.doesNotThrow(() => broken.error('x', { error: new Error('y') }));
  const hostile = { get explode() { throw new Error('getter'); } };
  assert.doesNotThrow(() => capture().log.error('x', hostile));
});

test('the default sink writes to stderr and never to stdout', t => {
  const out = [];
  const err = [];
  t.mock.method(process.stdout, 'write', chunk => { out.push(String(chunk)); return true; });
  t.mock.method(process.stderr, 'write', chunk => { err.push(String(chunk)); return true; });
  createLogger({ component: 'test' }).warn('careful', { code: 'ALP_X' });
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assert.equal(JSON.parse(err[0]).code, 'ALP_X');
  assert.ok(err[0].endsWith('\n'));
});

test('readLogTail returns records, scrubs older free-form lines, and tolerates a missing file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'alpd.log');
  assert.deepEqual(await readLogTail(file), []);
  const { lines, log } = capture();
  log.info('one');
  log.error('two', { code: 'ALP_X' });
  await writeFile(file, `2026-10-09T00:00:00.000Z fatal Error: token=${SECRETS[4]}\n${lines.join('\n')}\n{"truncated":`);
  const records = await readLogTail(file);
  assert.equal(records.length, 4);
  assert.ok(records[0].legacy && !records[0].legacy.includes(SECRETS[4]));
  assert.deepEqual(records.slice(1, 3).map(record => record.msg), ['one', 'two']);
  assert.ok(records[3].legacy);
  // A record written by an older or foreign writer is scrubbed on the way out as well.
  await writeFile(file, `${JSON.stringify({ time: 't', level: 'error', component: 'x', msg: `bad ${SECRETS[0]}`, token: SECRETS[1] })}\n`);
  assert.ok(!JSON.stringify(await readLogTail(file)).match(/sk-ant|ghp_/));
});
