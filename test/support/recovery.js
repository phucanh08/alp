import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';

let calls = 0;
/** A fake native harness; resuming a thread keeps its id, as Codex and Claude do. */
export function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, cwd, calls: [], threadId: `thread-${index}`, turnId: undefined, closed: false,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      lastText() { return this.started.at(-1)?.params.input.at(-1).text ?? ''; },
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      item(text = 'working') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `item-${index}-${++calls}`, text } });
      },
      finish(text = 'done') {
        this.item(text);
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

export async function until(check, what = 'condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected ${what} did not arrive`);
}

export const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

export async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false'); // the host's global setting must not turn the files' LF into CRLF
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const options = {
    supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'),
    worktreeDir: path.join(directory, 'worktrees'), copyDir: path.join(directory, 'copies'),
    liveFile: path.join(directory, 'state', 'live.json'), recallFile: path.join(directory, 'state', 'recall.json'),
  };
  return { directory, root, options };
}

