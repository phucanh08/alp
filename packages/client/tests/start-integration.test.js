// startIntegration with an explicit entry: that script runs detached with `--service` under the
// selected home, and no descriptor, environment or PATH candidate is consulted. Without an entry the
// discovery path is unchanged.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverIntegration, startIntegration } from '@anhlp/alp-client/index';

const outer = await mkdtemp(path.join(tmpdir(), 'alp-start-integration-'));
const pids = [];
after(async () => {
  // Also stop any service a failing run started but never read back.
  for (const file of await readdir(outer, { recursive: true }).catch(() => [])) {
    if (/started-[^/\\]+\.json$/.test(file)) pids.push(JSON.parse(await readFile(path.join(outer, file), 'utf8')).pid);
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await rm(outer, { recursive: true, force: true });
});

/** A service entry: records how it was started, then publishes its ready lock and <name>.json and stays up. */
function entrySource(tag) {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = process.env.ALP_HOME, name = process.env.TEST_INTEGRATION_NAME;
writeFileSync(path.join(home, ${JSON.stringify(`started-${tag}.json`)}), JSON.stringify({ argv: process.argv.slice(2), home, pid: process.pid }));
mkdirSync(path.join(home, 'integrations'), { recursive: true });
writeFileSync(path.join(home, name + '.json'), JSON.stringify({ pid: process.pid }));
writeFileSync(path.join(home, 'integrations', name + '.lock'), JSON.stringify({ pid: process.pid, bootTime: Math.round((Date.now() - os.uptime() * 1000) / 1000), startedAt: new Date().toISOString(), ready: true }));
setInterval(() => {}, 60_000);
`;
}

async function fixture(name) {
  const directory = await mkdtemp(path.join(outer, 'case-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const write = async (file, tag) => { await writeFile(file, entrySource(tag)); return file; };
  return { directory, home, name, write };
}

async function started(home, tag) {
  const record = JSON.parse(await readFile(path.join(home, `started-${tag}.json`), 'utf8'));
  pids.push(record.pid);
  return record;
}

const absent = file => stat(file).then(() => false, error => error.code === 'ENOENT');
const escape = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** Sets (or, for undefined, deletes) these variables and every discovery override for `name`, restoring them after the test. */
function environment(t, name, values) {
  const keys = new Set(['ALP_WEB_INTEGRATION', 'ALP_INTEGRATION_ENTRY', `ALP_${name.toUpperCase()}_INTEGRATION`, 'TEST_INTEGRATION_NAME', ...Object.keys(values)]);
  const saved = new Map([...keys].map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries({ TEST_INTEGRATION_NAME: name, ...values })) if (value !== undefined) process.env[key] = value;
  t.after(() => { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; });
}

/** Control which side of the startup check observes a real child's nonzero exit.
 * The launcher distinguishes an exit seen in its initial 150ms check from a readiness
 * deadline with no lock. Child startup has no 150ms upper bound on a loaded machine.
 * Only the late schedule advances the clock, after the real exit, to avoid a 30s test.
 */
async function exitSchedule(t, { releaseAfterCheck } = {}, run) {
  const spawn = childProcess.spawn;
  const setTimeout = globalThis.setTimeout;
  const now = Date.now;
  let exit, child, offset = 0;
  const events = [];
  const children = [];
  const spawnMock = t.mock.method(childProcess, 'spawn', (...args) => {
    child = spawn(...args);
    const stopped = new Promise(resolve => child.once('close', resolve));
    children.push({ child, stopped });
    exit = new Promise(resolve => child.once('exit', code => {
      events.push(`exit:${code}`);
      resolve();
    }));
    return child;
  });
  syncBuiltinESMExports();
  const clockMock = t.mock.method(Date, 'now', () => now() + offset);
  const timerMock = t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 150) return setTimeout(async () => {
      if (!releaseAfterCheck) {
        child.ref();
        await exit;
        child.unref();
      }
      events.push('startup-check');
      callback(...args);
    }, 0);
    if (ms === 100 && releaseAfterCheck) return setTimeout(async () => {
      // Reaching the readiness poll proves the initial startup check has completed.
      events.push('readiness-poll');
      child.ref();
      await releaseAfterCheck();
      await exit;
      child.unref();
      offset = 30_001;
      callback(...args);
    }, 0);
    return setTimeout(callback, ms, ...args);
  });
  try {
    await run();
    return events;
  } finally {
    timerMock.mock.restore();
    clockMock.mock.restore();
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    for (const { child, stopped } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.ref();
        child.kill('SIGKILL');
      }
      await stopped;
    }
  }
}

test('the exit schedule stops its detached child when the caller fails before polling', async t => {
  const f = await fixture('cleanup');
  const service = await f.write(path.join(f.directory, 'service.mjs'), 'cleanup');
  let child;
  const failure = new Error('caller failed before readiness polling');
  await assert.rejects(exitSchedule(t, { releaseAfterCheck: () => assert.fail('must not poll') }, async () => {
    child = childProcess.spawn(process.execPath, [service], {
      detached: true, stdio: 'ignore', env: { ...process.env, ALP_HOME: f.home, TEST_INTEGRATION_NAME: f.name },
    });
    child.unref();
    // Independent fallback also keeps a failed cleanup regression from leaking a service.
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    throw failure;
  }), error => error === failure);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('an explicit entry is started with --service under the selected home and skips discovery', async t => {
  const f = await fixture('sample');
  const explicit = await f.write(path.join(f.directory, 'explicit.mjs'), 'explicit');
  // Every discovery source names a different script; none of them may run.
  const discovered = await f.write(path.join(f.directory, 'discovered.mjs'), 'discovered');
  await mkdir(path.join(f.home, 'integrations'), { recursive: true });
  await writeFile(path.join(f.home, 'integrations', `${f.name}.json`), JSON.stringify({ main: discovered }));
  environment(t, f.name, { ALP_WEB_INTEGRATION: discovered, ALP_INTEGRATION_ENTRY: discovered, ALP_SAMPLE_INTEGRATION: discovered });

  const lock = await startIntegration({ name: f.name, entry: explicit, home: f.home });
  const record = await started(f.home, 'explicit');
  assert.deepEqual(record.argv, ['--service']);
  assert.equal(record.home, f.home);
  assert.equal(lock.pid, record.pid);
  assert.ok(await absent(path.join(f.home, 'started-discovered.json')), 'no discovered entry may start');

  // A live ready owner is reused: a second call starts nothing new.
  const again = await startIntegration({ name: f.name, entry: explicit, home: f.home });
  assert.equal(again.pid, record.pid);
  // Even then a missing entry is an error, not a silent reuse.
  const missing = path.join(f.directory, 'missing.mjs');
  await assert.rejects(startIntegration({ name: f.name, entry: missing, home: f.home }), new RegExp(`entry not found: ${escape(missing)}`));
});

test('a relative entry resolves against the working directory', async t => {
  const f = await fixture('relative');
  await f.write(path.join(f.directory, 'service.mjs'), 'relative');
  environment(t, f.name, {});
  const cwd = process.cwd();
  process.chdir(f.directory);
  t.after(() => { process.chdir(cwd); });
  const lock = await startIntegration({ name: f.name, entry: 'service.mjs', home: f.home });
  assert.equal(lock.pid, (await started(f.home, 'relative')).pid);
});

test('a missing or invalid entry fails before anything is spawned, even when discovery would succeed', async t => {
  const f = await fixture('missing');
  const discovered = await f.write(path.join(f.directory, 'discovered.mjs'), 'discovered');
  environment(t, f.name, { ALP_INTEGRATION_ENTRY: discovered });
  const missing = path.join(f.directory, 'missing.mjs');
  await assert.rejects(startIntegration({ name: f.name, entry: missing, home: f.home }), new RegExp(`entry not found: ${escape(missing)}`));
  for (const entry of ['', 42, null]) await assert.rejects(startIntegration({ name: f.name, entry, home: f.home }), TypeError);
  await assert.rejects(startIntegration({ name: f.name, entry: f.directory, home: f.home }), /entry not found/);
  assert.ok(await absent(path.join(f.home, 'started-discovered.json')));
});

test('integration names are single lowercase path segments, with or without an entry', async t => {
  const f = await fixture('names');
  const service = await f.write(path.join(f.directory, 'service.mjs'), 'names');
  environment(t, f.name, { ALP_INTEGRATION_ENTRY: service });
  for (const name of ['', 'Web', '../x', 'a/b', 'a\\b', '.web', '-web', 'web.lock', 7]) {
    await assert.rejects(startIntegration({ name, entry: service, home: f.home }), TypeError, String(name));
    await assert.rejects(startIntegration({ name, home: f.home }), TypeError, String(name));
  }
  await assert.rejects(startIntegration('../x'), TypeError);
  assert.ok(await absent(path.join(f.home, 'started-names.json')), 'nothing may start for an invalid name');
});

test('discoverIntegration validates the name before reading any descriptor or override', async t => {
  const f = await fixture('discover-names');
  const service = await f.write(path.join(f.directory, 'service.mjs'), 'discover-names');
  // A descriptor outside <home>/integrations that `../outside` would otherwise resolve to.
  await writeFile(path.join(f.home, 'outside.json'), JSON.stringify({ main: service }));
  environment(t, f.name, { ALP_INTEGRATION_ENTRY: '' });
  assert.equal(await discoverIntegration(f.name, { home: f.home }), undefined, 'the fixture registers nothing by default');
  for (const name of ['../outside', '', 'Web', 'a/b', 'a\\b', '.web', '-web', 'web.lock', 7, null]) {
    await assert.rejects(discoverIntegration(name, { home: f.home }), TypeError, String(name));
  }
  // Even an explicit override is not returned for an invalid name.
  environment(t, f.name, { ALP_INTEGRATION_ENTRY: service });
  await assert.rejects(discoverIntegration('../outside', { home: f.home }), TypeError);
});

test('without an entry, discovery still selects the script (unchanged behaviour)', async t => {
  const f = await fixture('discovery');
  const discovered = await f.write(path.join(f.directory, 'discovered.mjs'), 'discovered');
  environment(t, f.name, { ALP_INTEGRATION_ENTRY: discovered });
  const lock = await startIntegration({ name: f.name, home: f.home });
  const record = await started(f.home, 'discovered');
  assert.deepEqual(record.argv, ['--service']);
  assert.equal(lock.pid, record.pid);
});

test('args follow --service, and must be strings', async t => {
  const f = await fixture('args');
  environment(t, f.name, {});
  const service = await f.write(path.join(f.directory, 'service.mjs'), 'args');
  const lock = await startIntegration({ name: f.name, entry: service, home: f.home, args: ['--project', '/some where'] });
  const record = await started(f.home, 'args');
  assert.deepEqual(record.argv, ['--service', '--project', '/some where']);
  assert.equal(lock.pid, record.pid);
  for (const args of ['--project', [1], [null]]) await assert.rejects(startIntegration({ name: f.name, entry: service, home: f.home, args }), /args must be a list of strings/);
});

test('web.enabled=false refuses web only; messages name the integration, its entry and its own log', async t => {
  const f = await fixture('gated');
  environment(t, f.name, {});
  await writeFile(path.join(f.home, 'settings.json'), JSON.stringify({ web: { enabled: false } }));
  const service = await f.write(path.join(f.directory, 'service.mjs'), 'gated');
  await assert.rejects(startIntegration({ name: 'web', entry: service, home: f.home }), /^Error: alp web is disabled by settings \("web\.enabled": false\)\.$/);
  // Another integration is not alp web: the switch does not apply.
  const lock = await startIntegration({ name: f.name, entry: service, home: f.home });
  assert.equal(lock.pid, (await started(f.home, 'gated')).pid);

  // An entry that exits at once is reported with its integration, entry and log path.
  const failing = path.join(f.directory, 'failing.mjs');
  await writeFile(failing, 'process.exit(1);');
  const logs = path.join(f.home, 'logs', 'integrations');
  const events = await exitSchedule(t, {}, async () => {
    await assert.rejects(startIntegration({ name: 'other', entry: failing, home: f.home }), new RegExp(`^Error: ALP integration other \\(entry ${escape(failing)}\\) failed to start; see ${escape(path.join(logs, 'other.log'))}$`));
    await assert.rejects(startIntegration({ name: 'paseo', entry: failing, home: f.home }), new RegExp(`^Error: The Paseo integration \\(entry ${escape(failing)}\\) failed to start; see ${escape(path.join(logs, 'paseo.log'))}$`));
    await rm(path.join(f.home, 'settings.json'));
    await assert.rejects(startIntegration({ name: 'web', entry: failing, home: f.home }), new RegExp(`^Error: alp web \\(entry ${escape(failing)}\\) failed to start; see ${escape(path.join(logs, 'alp-web.log'))}$`));
  });
  assert.deepEqual(events, ['exit:1', 'startup-check', 'exit:1', 'startup-check', 'exit:1', 'startup-check']);
  // A missing integration: the name decides the guidance.
  await assert.rejects(startIntegration({ name: 'nothing-here', home: f.home }), /^Error: ALP integration nothing-here is not installed/);
});

test('an exit after the startup check retains the no-lock readiness deadline diagnostic', async t => {
  const f = await fixture('late-exit');
  environment(t, f.name, {});
  const failing = path.join(f.directory, 'failing.mjs');
  const release = path.join(f.directory, 'release');
  await writeFile(failing, `import { existsSync } from 'node:fs';
const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(1); }, 10);
`);
  const events = await exitSchedule(t, { releaseAfterCheck: () => writeFile(release, '') }, async () => {
    await assert.rejects(startIntegration({ name: f.name, entry: failing, home: f.home }),
      new RegExp(`^Error: ALP integration late-exit \\(entry ${escape(failing)}\\) did not start; see ${escape(path.join(f.home, 'logs', 'integrations', 'late-exit.log'))}$`));
  });
  assert.deepEqual(events, ['startup-check', 'readiness-poll', 'exit:1']);
});

test('web is never discovered; ALP_WEB_INTEGRATION names the Paseo integration only', async t => {
  const f = await fixture('paseo');
  const legacy = await f.write(path.join(f.directory, 'legacy.mjs'), 'legacy');
  const own = await f.write(path.join(f.directory, 'own.mjs'), 'own');
  environment(t, 'paseo', { ALP_WEB_INTEGRATION: legacy, ALP_INTEGRATION_ENTRY: undefined });
  // Everything once registered for `web` is the Paseo integration before its rename: a descriptor,
  // the environment override. None of it may run under the web lock.
  await mkdir(path.join(f.home, 'integrations'), { recursive: true });
  await writeFile(path.join(f.home, 'integrations', 'web.json'), JSON.stringify({ main: legacy }));
  assert.equal(await discoverIntegration('web', { home: f.home }), undefined);
  await assert.rejects(startIntegration({ name: 'web', home: f.home }), /alp web runs the alp-web service of the ALP CLI/);
  assert.ok(await absent(path.join(f.home, 'started-legacy.json')), 'nothing was started');
  // For paseo, the pre-rename override still works for one release, after the integration's own.
  assert.equal(await discoverIntegration('paseo', { home: f.home }), legacy);
  process.env.ALP_PASEO_INTEGRATION = own;
  assert.equal(await discoverIntegration('paseo', { home: f.home }), own);
  // And it never applies to another name.
  delete process.env.ALP_PASEO_INTEGRATION;
  assert.equal(await discoverIntegration('sample', { home: f.home }), undefined);
});
