// Opt-in: uses real models and a declared scratch Paseo daemon (scratch-daemon.ts). It refuses the
// user's own daemon and ~/.alp before connecting or creating fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { initProject } from '@anhlp/alp-core/init';
import { readRunLog, requireScratchDaemon, type RunLogLine } from './scratch-daemon.ts';

const { url, runLogDir } = requireScratchDaemon();

// The Paseo model picker selects the profile; main runs on its fixed model.
const workflow = process.argv[2] ?? 'pho';
assert.ok(['pho', 'cafe'].includes(workflow));
const provider = `alp/${workflow}`;
const runtime = 'claude';
const root = path.resolve('.alp-test', `workflow-${workflow}-${Date.now()}`);
await initProject(root);
const token = `PROOF_${randomUUID()}`;
await writeFile(path.join(root, 'proof.txt'), token);
type Snapshot = { [name: string]: Snapshot | string };
async function snapshot(directory: string): Promise<Snapshot> {
  const output: Snapshot = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    output[entry.name] = entry.isDirectory() ? await snapshot(file) : await readFile(file, 'base64');
  }
  return output;
}
const before = await snapshot(root);
const driver = new DaemonClient({ url, clientId: `alp-workflow-${Date.now()}` });
const client = createPaseoApi(driver);
let agent;
try {
  await driver.connect();
  agent = await client.agents.create({ cwd: root, title: `ALP ${workflow} smoke test`, config: {
    provider, modeId: 'read-only',
  } });
  console.log(JSON.stringify({ workflow, project: root, agent: agent.id }));
  const assignment = 'Use alp_delegate to assign peer to read proof.txt and return its exact content. Choose an explicit available model and effort for peer. After peer returns, use alp_delegate to reviewer with an explicit brief: review the existing proof.txt as the only supplied artifact (there is intentionally no git diff), verify it is a single PROOF_ token, and return its exact content and any finding. No files may be changed. Do not run unrelated tests or git commands. Return the token and actual handoffs.';
  const prompt = workflow === 'cafe'
    ? `Bounded integration test: delegate exactly one lead and pass it this complete brief verbatim, including the reviewer step: ${assignment} Lead calls both peer and reviewer. Main must not call peer or reviewer directly. Return the proof token and handoffs.`
    : `Bounded integration test in Phở. ${assignment} Also ask two oracles in parallel, one on each oracle model, to confirm the simplest approach to verifying a single token file. Include both oracle handoffs. Do not create lead. Finish once these calls complete.`;
  const result = await agent.run(prompt, { timeoutMs: 360_000 });
  // The proof is the peer's handoff, not main's last message: in Cafe main delegates lead in the
  // background and may end its turn before lead returns (t-0336). Wait for the tree to finish and the
  // peer and reviewer handoffs to reach the scratch home's run log.
  const finishedBy = (lines: RunLogLine[], role: string) => lines.filter(line => line.event === 'assignment.finished' && line.agent === role);
  let children;
  let log: RunLogLine[] = [];
  for (const deadline = Date.now() + 360_000; ;) {
    children = await driver.listProviderSubagents(agent.id);
    log = await readRunLog(runLogDir, root);
    const settled = !children.subagents?.some(child => child.status === 'running' && !child.title?.startsWith('ALP supervisor'));
    if (settled && finishedBy(log, 'peer').length && finishedBy(log, 'reviewer').length) break;
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const timeline = await agent.timeline.refetch({ limit: 100 });
  const evidence = { workflow, provider, project: root, agent: agent.id, result, children, log, timeline };
  const evidencePath = `.alp-test/workflow-${workflow}-${runtime}-e2e.json`;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ workflow, status: result.status, error: result.error, children: children.subagents?.map(child => ({ title: child.title, status: child.status, parent: child.parentSubagentId })), evidencePath }));
  const handoffs = (role: string) => finishedBy(log, role).map(line => ({ status: line.status, handoff: line.handoff }));
  console.log(JSON.stringify({ workflow, peer: handoffs('peer'), reviewer: handoffs('reviewer') }));
  assert.ok(log.length, `No run log for ${root} in ${runLogDir}: is ALP_TEST_ALP_HOME the scratch daemon's ALP home?`);
  assert.ok(finishedBy(log, 'peer').some(line => line.status === 'completed' && line.handoff?.summary?.includes(token)), 'Missing real peer proof: no completed peer handoff carries the token');
  assert.ok(finishedBy(log, 'reviewer').some(line => line.status === 'completed' && line.handoff), 'No completed reviewer handoff');
  assert.equal(children.error, null);
  const find = (name: string) => children.subagents.find(child => child.title?.startsWith(`ALP ${name}`));
  assert.ok(find('peer'), 'No real peer');
  assert.ok(find('reviewer'), 'No real reviewer');
  // Main's supervisor stays open beside it; assignments complete.
  assert.ok(find('supervisor'), 'No supervisor');
  for (const child of children.subagents.filter(child => !child.title?.startsWith('ALP supervisor'))) assert.equal(child.status, 'completed', JSON.stringify(child));
  if (workflow === 'pho') {
    assert.equal(find('lead'), undefined);
    assert.equal(children.subagents.filter(child => child.title?.startsWith('ALP oracle')).length, 2, 'Expected two oracles');
    assert.equal(find('peer')!.parentSubagentId, null);
  } else {
    assert.ok(find('lead'));
    assert.equal(find('peer')!.parentSubagentId, find('lead')!.id);
    assert.equal(find('reviewer')!.parentSubagentId, find('lead')!.id);
  }
  // Lessons main records are the only project change.
  const after = await snapshot(root);
  delete (after['.alp'] as Snapshot)['lessons.md'];
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ workflow, passed: true, evidencePath }));
} finally {
  if (agent) await agent.archive().catch(() => {});
  await client.dispose();
  await driver.close();
}
