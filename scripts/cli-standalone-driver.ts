// Copied into an isolated tarball consumer. Only installed APIs and Node builtins are used.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { connect, readLock } from '@anhlp/alp-client';

const cli = path.resolve(process.argv[2]);
// The consumer always runs this driver with ALP_HOME set (an unset one fails at the first path use, as before).
const home = (process.env.ALP_HOME as string);
const project = path.resolve('cli-project');
const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 });
let child: import('node:child_process').ChildProcessByStdio<import('node:stream').Writable,import('node:stream').Readable,import('node:stream').Readable>|undefined;
try {
  run('init', project);
  run('update-template', project);
  run('language');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false }, team: { pho: { main: { profiles: ['acp:fake'] } } } }));
  await saveEntry('providers', 'fake', { provider: { kind: 'acp', command: process.execPath, args: [path.resolve('fake-acp.ts')] } }, { scope: 'library', library: home });
  await saveEntry('agents', 'main', { instructions: 'Answer the prompt.', config: { provider: 'fake' } }, { scope: 'library', root: project, library: home });
  run('daemon', 'start');
  run('daemon', 'status');
  // `alp daemon start` above wrote the lock; the cast only drops readLock's `undefined`.
  const lock = ((await readLock(home)) as import('@anhlp/alp-client').DaemonLock);
  const client = await connect(lock.socket);
  try { assert.equal((await client.request('daemon.status')).pid, lock.pid); } finally { client.close(); }
  // alp dashboard runs alp-dashboard, which ships in the CLI as dist/alp-dashboard.js: no optional integration is
  // needed. A CLI built from a core-only source (no apps/gateway or apps/web, as
  // core-standalone-smoke builds it) has no alp-dashboard and must say so; package-smoke covers the full build.
  let webChecked;
  if (existsSync(path.join(path.dirname(cli), 'alp-dashboard.js'))) {
    // split() returns at least one element, so pop() returns a string.
    const printed = (run('dashboard', '--print').trim().split('\n').pop() as string);
    const match = /^(http:\/\/127\.0\.0\.1:\d+)\/#token=(alpgw1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43})$/.exec(printed);
    assert.ok(match, `alp dashboard --print: ${printed}`);
    const ticket = await fetch(`${match[1]}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${match[2]}` } });
    assert.equal(ticket.status, 201, 'the printed token is a live credential');
    await ticket.body?.cancel();
    assert.equal(JSON.parse(await readFile(path.join(home, 'dashboard.json'), 'utf8')).app, 'alp-dashboard');
    webChecked = 'alp dashboard (alp-dashboard)';
  } else {
    assert.throws(() => run('dashboard', '--print'), /alp dashboard is not built: .*alp-dashboard\.js is missing/);
    webChecked = 'alp dashboard refused (core-only build: no alp-dashboard)';
  }
  run('daemon', 'status');

  child = spawn(process.execPath, [cli, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  // `any`: each ACP method answers its own result shape; the asserts below read the fields they need.
  const pending: Map<number,{ resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }> = new Map();
  const updates: { sessionUpdate?: string; content?: { text?: string; }; }[] = [];
  let sequence = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); // stdout must contain protocol frames only.
    if (message.method === 'session/update') updates.push(message.params.update);
    else if (pending.has(message.id)) {
      const { resolve, reject, timer } = (pending.get(message.id) as { resolve: (result: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }); // has() above; `any` as for `pending`
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
  });
  // `any`: as for `pending`, the result's shape depends on the method.
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    (child as NonNullable<typeof child>).stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); // spawned above, before any request
  });
  assert.equal((await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).agentInfo.name, 'alp');
  const { sessionId } = await request('session/new', { cwd: project, mcpServers: [] });
  assert.equal((await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'fake:say isolated-cli-ok' }] })).stopReason, 'end_turn');
  assert.ok(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => (update.content as { text?: string }).text).join('').includes('isolated-cli-ok'), 'installed alp acp streams the fake provider response');
  assert.equal(await readFile(path.join(home, 'integrations/paseo.json')).catch(() => undefined), undefined);
  console.log(`INSTALLED_CLI_OK init/upgrade + daemon + IPC + ${webChecked} + ACP stdio handshake/prompt/stream; no Paseo`);
} finally {
  child?.kill();
  // alp-dashboard keeps alpd up; stop it first (its own lock and dashboard.json name it), then alpd.
  const web = await readFile(path.join(home, 'dashboard.json'), 'utf8').then(JSON.parse, () => undefined);
  if (web?.app === 'alp-dashboard' && Number.isSafeInteger(web.pid)) {
    try { process.kill(web.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 200; i++) { try { process.kill(web.pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  run('daemon', 'stop');
}
