// Copied into an isolated tarball consumer. Only installed APIs and Node builtins are used.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { connect, readLock } from '@anhlp/alp-client';

const cli = path.resolve(process.argv[2]);
const home = process.env.ALP_HOME;
const project = path.resolve('cli-project');
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 });
let child;
try {
  run('init', project);
  run('upgrade', project);
  run('language');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false }, team: { pho: { main: { profiles: ['acp:fake'] } } } }));
  await saveEntry('providers', 'fake', { provider: { kind: 'acp', command: process.execPath, args: [path.resolve('fake-acp.js')] } }, { scope: 'library', library: home });
  await saveEntry('agents', 'main', { instructions: 'Answer the prompt.', config: { provider: 'fake' } }, { scope: 'library', root: project, library: home });
  run('daemon', 'start');
  run('daemon', 'status');
  const lock = await readLock(home);
  const client = await connect(lock.socket);
  try { assert.equal((await client.request('daemon.status')).pid, lock.pid); } finally { client.close(); }
  // A missing optional integration gives installation guidance and leaves alpd working.
  assert.throws(() => run('web', '--print'), /optional integration package/);
  run('daemon', 'status');

  child = spawn(process.execPath, [cli, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  const updates = [];
  let sequence = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); // stdout must contain protocol frames only.
    if (message.method === 'session/update') updates.push(message.params.update);
    else if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  assert.equal((await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).agentInfo.name, 'alp');
  const { sessionId } = await request('session/new', { cwd: project, mcpServers: [] });
  assert.equal((await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'fake:say isolated-cli-ok' }] })).stopReason, 'end_turn');
  assert.ok(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join('').includes('isolated-cli-ok'), 'installed alp acp streams the fake provider response');
  assert.equal(await readFile(path.join(home, 'integrations/paseo.json')).catch(() => undefined), undefined);
  console.log('INSTALLED_CLI_OK init/upgrade + daemon + IPC + ACP stdio handshake/prompt/stream; no Paseo');
} finally {
  child?.kill();
  run('daemon', 'stop');
}
