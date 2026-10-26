// startIntegration with an explicit entry: that script runs detached with `--service` under the
// selected home, and no descriptor, environment or PATH candidate is consulted. Without an entry the
// discovery path is unchanged.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startIntegration } from '@anhlp/alp-client/index';

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
import path from 'node:path';
const home = process.env.ALP_HOME, name = process.env.TEST_INTEGRATION_NAME;
writeFileSync(path.join(home, ${JSON.stringify(`started-${tag}.json`)}), JSON.stringify({ argv: process.argv.slice(2), home, pid: process.pid }));
mkdirSync(path.join(home, 'integrations'), { recursive: true });
writeFileSync(path.join(home, name + '.json'), JSON.stringify({ pid: process.pid }));
writeFileSync(path.join(home, 'integrations', name + '.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ready: true }));
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

test('an explicit entry is started with --service under the selected home and skips discovery', async t => {
  const f = await fixture('sample');
  const explicit = await f.write(path.join(f.directory, 'explicit.mjs'), 'explicit');
  // Every discovery source names a different script; none of them may run.
  const discovered = await f.write(path.join(f.directory, 'discovered.mjs'), 'discovered');
  await mkdir(path.join(f.home, 'integrations'), { recursive: true });
  await writeFile(path.join(f.home, 'integrations', `${f.name}.json`), JSON.stringify({ main: discovered }));
  const env = { ALP_WEB_INTEGRATION: discovered, ALP_INTEGRATION_ENTRY: discovered, ALP_SAMPLE_INTEGRATION: discovered, TEST_INTEGRATION_NAME: f.name };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });

  const lock = await startIntegration({ name: f.name, entry: explicit, home: f.home });
  const record = await started(f.home, 'explicit');
  assert.deepEqual(record.argv, ['--service']);
  assert.equal(record.home, f.home);
  assert.equal(lock.pid, record.pid);
  assert.ok(await absent(path.join(f.home, 'started-discovered.json')), 'no discovered entry may start');

  // A live ready owner is reused: a second call starts nothing new.
  const again = await startIntegration({ name: f.name, entry: explicit, home: f.home });
  assert.equal(again.pid, record.pid);
});

test('a relative entry resolves against the working directory', async t => {
  const f = await fixture('relative');
  await f.write(path.join(f.directory, 'service.mjs'), 'relative');
  process.env.TEST_INTEGRATION_NAME = f.name;
  const cwd = process.cwd();
  process.chdir(f.directory);
  t.after(() => { process.chdir(cwd); delete process.env.TEST_INTEGRATION_NAME; });
  const lock = await startIntegration({ name: f.name, entry: 'service.mjs', home: f.home });
  assert.equal(lock.pid, (await started(f.home, 'relative')).pid);
});

test('a missing or invalid entry fails before anything is spawned, even when discovery would succeed', async t => {
  const f = await fixture('missing');
  const discovered = await f.write(path.join(f.directory, 'discovered.mjs'), 'discovered');
  process.env.ALP_INTEGRATION_ENTRY = discovered; process.env.TEST_INTEGRATION_NAME = f.name;
  t.after(() => { delete process.env.ALP_INTEGRATION_ENTRY; delete process.env.TEST_INTEGRATION_NAME; });
  const missing = path.join(f.directory, 'missing.mjs');
  await assert.rejects(startIntegration({ name: f.name, entry: missing, home: f.home }), new RegExp(`entry not found: ${missing.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  for (const entry of ['', 42, null]) await assert.rejects(startIntegration({ name: f.name, entry, home: f.home }), TypeError);
  await assert.rejects(startIntegration({ name: f.name, entry: f.directory, home: f.home }), /entry not found/);
  assert.ok(await absent(path.join(f.home, 'started-discovered.json')));
});

test('without an entry, discovery still selects the script (unchanged behaviour)', async t => {
  const f = await fixture('discovery');
  const discovered = await f.write(path.join(f.directory, 'discovered.mjs'), 'discovered');
  process.env.ALP_INTEGRATION_ENTRY = discovered; process.env.TEST_INTEGRATION_NAME = f.name;
  t.after(() => { delete process.env.ALP_INTEGRATION_ENTRY; delete process.env.TEST_INTEGRATION_NAME; });
  const lock = await startIntegration({ name: f.name, home: f.home });
  const record = await started(f.home, 'discovered');
  assert.deepEqual(record.argv, ['--service']);
  assert.equal(lock.pid, record.pid);
});
