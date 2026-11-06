import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { profileFor } from '@anhlp/alp-core/permissions';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { fakeTransport, until } from '../support/fake-agent.js';
import { teardown } from '../support/teardown.js';

/**
 * A custom agent serving as a team's advisor or reviewer is read-only, whatever its name, its
 * agent.json mode, or a permission profile that gives it more (P0: no name-based exemption).
 */
async function setup(t, members) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-advisor-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'home');
  await initProject(root);
  await seedLibrary(library);
  for (const name of ['auditor', 'checker']) {
    await mkdir(path.join(library, 'agents', name), { recursive: true });
    await writeFile(path.join(library, 'agents', name, 'AGENT.md'), `# ${name}\n`);
    // The agent's own default asks for writes.
    await writeFile(path.join(library, 'agents', name, 'agent.json'), JSON.stringify({ mode: 'workspace-write' }));
  }
  await mkdir(path.join(library, 'teams', 'squad'), { recursive: true });
  await writeFile(path.join(library, 'teams', 'squad', 'team.json'), JSON.stringify({
    label: 'Squad', description: 'Test team', main: 'main',
    members: { main: {}, ...members },
    delegation: { main: Object.keys(members) },
  }));
  // Conflicting profiles: settings give both agents more than read-only.
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'squad', supervisor: false }, permissions: { agents: { auditor: 'full-access', checker: 'workspace-write' } } }));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, libraryDir: library, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, workflow: 'squad' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  return { root, library, runtime, agents, main: agents[0] };
}

test('profileFor caps a read-only member at read-only, even over a profile that gives more; others keep theirs', async t => {
  const { root, library } = await setup(t, { auditor: { role: 'advisor' } });
  assert.deepEqual(await profileFor(root, library, 'auditor', { readOnly: true }), { name: 'full-access', base: 'read-only', cappedFrom: 'full-access', allow: [], ask: [], deny: [], beyondMode: 'refuse' });
  assert.equal((await profileFor(root, library, 'auditor')).base, 'full-access', 'outside a read-only role the profile applies as before');
  assert.equal((await profileFor(root, library, 'nobody', { readOnly: true })).base, 'read-only', 'no profile at all: read-only');
});

test('a custom advisor and a custom reviewer run read-only when delegated, whatever the caller, agent.json or settings ask', async t => {
  const { main, agents } = await setup(t, { auditor: { role: 'advisor' }, checker: { role: 'reviewer' } });
  const advice = await main.call('alp_delegate', { agent: 'auditor', task: 'Review the layering', mode: 'workspace-write', wait: false });
  assert.ok(advice.assignmentId, JSON.stringify(advice));
  assert.equal(advice.mode, 'read-only');
  await until(() => agents.length === 2, 'the auditor');
  assert.equal(agents[1].config.sandbox, 'read-only');
  // Not a writer: it gets no task, and it is counted as an advisor, so a second one runs beside it.
  assert.match((await main.call('alp_delegate', { agent: 'auditor', task: 'x', taskId: 't-none', wait: false })).error, /taskId gives a task to lead or peer/);
  const review = await main.call('alp_delegate', { agent: 'checker', task: 'Review the diff', mode: 'full-access', wait: false });
  assert.ok(review.assignmentId, JSON.stringify(review));
  assert.equal(review.mode, 'read-only');
  await until(() => agents.length === 3, 'the checker');
  assert.equal(agents[2].config.sandbox, 'read-only');
});

test('the same agent serving as a peer keeps its profile: the cap follows the role, not the name', async t => {
  const { main, agents } = await setup(t, { auditor: { role: 'peer' } });
  const work = await main.call('alp_delegate', { agent: 'auditor', task: 'Change it', mode: 'workspace-write', wait: false });
  assert.ok(work.assignmentId, JSON.stringify(work));
  assert.equal(work.mode, undefined, 'not capped: the result names a mode only when a cap changed it');
  await until(() => agents.length === 2, 'the auditor');
  assert.equal(agents[1].config.sandbox, 'workspace-write');
});
