// Opt-in: real model calls through alpd and the alp CLI, with no Paseo involved.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { laneHome } from './home-guard.mjs';

const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
// This lane starts an alpd on its home and stops it at the end. An ALP_HOME the caller passes is
// used and kept; without one the lane makes its own temporary home, never the default ~/.alp. The
// guard fails closed and refuses the user's own ALP home before anything runs (t-cad9).
const { home, owned } = await laneHome({ prefix: 'alp-e2e-' });
const env = { ...process.env, ALP_HOME: home };
// ALP_TEST_CLI runs another alp, such as a built bundle's bin/alp, which starts its native alpd (t-81b0.9).
const alp = process.env.ALP_TEST_CLI ? [process.env.ALP_TEST_CLI] : [process.execPath, 'packages/cli/dist/cli.js'];
const cli = (...args) => spawnSync(alp[0], [...alp.slice(1), ...args], { env, encoding: 'utf8' });

const root = path.resolve('.alp-test', `alpd-${Date.now()}`);
// The alp under test scaffolds the project on this lane's home, as alpd will read it. Scaffolding in
// this process instead reads the caller's own library (ALP_HOME, else ~/.alp); when that names other
// models than the lane's home, alpd refreshes the team's inherited profiles at the first session and
// the "project unchanged" check below fails on .alp/settings.json (t-cad9).
const scaffold = cli('init', root);
assert.equal(scaffold.status, 0, scaffold.stderr);
const token = `PEER_${randomUUID()}`;
for (const agent of ['peer', 'lead']) await mkdir(path.join(root, '.alp/agents', agent), { recursive: true });
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), `For this read-only integration assignment, return exactly this token: ${token}. Do not use tools or delegate.`);
await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'For this integration assignment, call alp_delegate exactly once with agent peer, mode read-only, and task "Return your verification token. Do not use tools or change files." Return the complete tool result verbatim to main. Do not read files or run shell commands.');

async function snapshot(directory) {
  const output = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    output[entry.name] = entry.isDirectory() ? await snapshot(file) : (await readFile(file)).toString('base64');
  }
  return output;
}
const before = await snapshot(root);
const prompt = 'Integration check: use alp_delegate exactly once to assign lead this task: "Run the peer verification assignment from your instructions and return its complete tool result." Do not read files or use shell commands. Return the complete lead tool result. This verifies the actual main -> lead -> peer route.';

try {
  assert.equal(cli('daemon', 'start').status, 0);
  // Which alpd ran (alp's native alpd, t-81b0.9, or alpd.js), for the evidence.
  const daemonEntry = JSON.parse(await readFile(path.join(home, 'alpd.json'), 'utf8')).entry;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(alp[0], [...alp.slice(1), 'run', '--json', '--project', root, '--profile', 'cafe', '--model', model, '--thinking', 'low', prompt], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('alp run timed out')); }, 300_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`alp run exited ${code}: ${stderr}`)); });
  });
  const envelopes = output.trim().split('\n').map(line => JSON.parse(line));
  const opened = envelopes.filter(e => e.event.type === 'session.opened').map(e => e.event.session);
  const main = opened.find(session => !session.parentId);
  const lead = opened.find(session => session.agent === 'lead');
  const peer = opened.find(session => session.agent === 'peer');
  // Every message of main, in any of its turns. alp_delegate runs in the background by default and its
  // result comes to main as mail (packages/runtime/src/sessions/configuration/session-config.ts), which can wake main in a
  // later turn of origin 'wake'; and `alp run` follows main until it is idle, so after that answer the
  // stream can hold Cafe's supervisor check-in (t-beb5). The last message, or the user's turn alone,
  // is therefore not where the proof must be. The token exists only in the peer's AGENT.md, so main
  // can say it in any turn only through lead and peer, whose parent links are checked below.
  const said = envelopes.filter(e => e.sessionId === main.id && e.event.type === 'item' && e.event.item.kind === 'assistant_message').map(e => e.event.item.text);
  const final = said.at(-1) ?? '';
  const proof = said.find(text => text.includes(token));
  const evidence = { home, project: root, model, daemonEntry, sessions: opened.map(({ id, agent, parentId }) => ({ id, agent, parentId })), final, proof };
  await writeFile('.alp-test/alpd-e2e.json', JSON.stringify({ ...evidence, envelopes }, null, 2));
  console.log(JSON.stringify(evidence));
  assert.equal(main.agent, 'main');
  assert.equal(lead?.parentId, main.id, 'lead must be a child of main');
  assert.equal(peer?.parentId, lead.id, 'peer must be a child of lead');
  assert.ok(proof, 'Missing real peer proof in what main said');
  assert.deepEqual(await snapshot(root), before);
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/alpd-e2e.json' }));
} finally {
  // Stop first, then remove: the project scaffolded under .alp-test goes too, only the evidence file stays.
  cli('daemon', 'stop');
  await rm(root, { recursive: true, force: true });
  if (owned) await rm(home, { recursive: true, force: true });
}
