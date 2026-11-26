// Actual self-contained consumer executables; never touches the user's running daemon/home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const requested = process.env.ALP_NATIVE_CONSUMER_BUNDLES?.split(',') ?? ['packages/daemon/dist/alpd.js'];
const skip = !['darwin', 'linux'].includes(process.platform);
async function until(check, what) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail(what);
}
for (const bundle of requested) test(`shipped native terminal in copied ${bundle}, compiler PATH absent`, { skip }, async t => {
  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-terminal-package-')));
  const home = path.join(work, 'home'), project = path.join(work, 'project');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true, allowPaseoTerminal: true }), { mode: 0o600 });
  await initProject(project);
  await cp(path.join(root, bundle), path.join(work, 'alpd.mjs'));
  await cp(path.join(root, path.dirname(bundle), 'terminal-native'), path.join(work, 'terminal-native'), { recursive: true });
  const child = spawn(process.execPath, [path.join(work, 'alpd.mjs')], { cwd: work, env: { ...process.env, ALP_HOME: home, SHELL: '/bin/sh', PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', v => { output += v; }); child.stderr.on('data', v => { output += v; });
  const exited = once(child, 'exit'); let client;
  t.after(async () => {
    if (client) { await client.request('daemon.shutdown').catch(() => {}); client.close(); }
    // This direct ChildProcess is our own unreaped fixture; no numeric discovery/group signal.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited; await rm(work, { recursive: true, force: true });
  });
  await until(async () => { assert.equal(child.exitCode, null, output); return (await readLock(home))?.ready; }, 'copied daemon startup');
  client = await connect((await readLock(home)).socket, { name: 'native-consumer', version: '1' });
  const hello = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('terminal'), JSON.stringify(hello));
  await client.request('project.register', { directory: project, ifRevision: 0, requestId: 'project' });
  const { workspaces } = await client.request('workspace.list', {});
  const workspaceId = workspaces.find(w => w.directory === project || w.canonical === project)?.id;
  assert.ok(workspaceId, JSON.stringify(workspaces));
  const { terminal } = await client.request('terminal.create', { workspaceId, cols: 80, rows: 24, requestId: 'terminal' });
  await client.request('terminal.attach', { terminalId: terminal.terminalId });
  await client.request('terminal.input', { terminalId: terminal.terminalId, data: "printf '\\nPACKAGED_NATIVE_OK\\n'\r" });
  await until(async () => (await client.request('terminal.capture', { terminalId: terminal.terminalId })).lines.some(line => line === 'PACKAGED_NATIVE_OK'), 'native output/capture');
  assert.deepEqual(await client.request('terminal.close', { terminalId: terminal.terminalId }), { closed: true });
});
