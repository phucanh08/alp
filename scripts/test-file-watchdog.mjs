// Internal coordinator for test-lib: each file gets a hard wall-clock limit, including
// time after its tests finish when leaked handles can keep Node's test child alive.
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';
const tracker = join(import.meta.dirname, 'test-process-tracker.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let cleanupUnconfirmed = false;
function unconfirmed(file) {
  cleanupUnconfirmed = true;
  console.error(`[test-file] CLEANUP-UNCONFIRMED ${file}; retaining runner scratch`);
  if (process.env.ALP_TEST_RETAIN) writeFileSync(process.env.ALP_TEST_RETAIN, 'cleanup unconfirmed\n');
}
async function control() {
  const secret = randomUUID();
  const root = randomUUID();
  const endpoint = process.platform === 'win32' ? ['', '', '.', 'pipe', `alp-test-${root}`].join(String.fromCharCode(92)) : join(tmpdir(), `at-${root.slice(0, 8)}.sock`);
  const peers = new Map();
  const edges = new Map();
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let peer;
    let input = '';
    socket.on('data', data => {
      input += data;
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!peer) {
          if (message.type !== 'hello' || message.token !== secret) { socket.destroy(); return; }
          peer = { id: message.id, socket, ack: false };
          peers.set(peer.id, peer);
        } else if (message.type === 'spawn') edges.set(message.id, { owner: peer.id });
        else if (message.type === 'exit' && edges.get(message.id)?.owner === peer.id) edges.delete(message.id);
        else if (message.type === 'ack') peer.ack = true;
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  return {
    env: { ALP_TEST_CONTROL: endpoint, ALP_TEST_SECRET: secret, ALP_TEST_PROCESS: root,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(tracker)}` },
    async cleanup() {
      // Bottom-up ACKs ensure a parent is never killed before its detached
      // descendants have been handled by their actual spawning owners.
      const deadline = Date.now() + 1500;
      const requested = new Set();
      const uncertain = !peers.has(root) || [...edges.keys()].some(id => !peers.has(id));
      while (Date.now() < deadline) {
        for (const peer of peers.values()) {
          if (requested.has(peer.id) || peer.socket.destroyed) continue;
          const waiting = [...edges].some(([id, edge]) => edge.owner === peer.id && peers.has(id) && !peers.get(id).ack);
          if (!waiting) { requested.add(peer.id); peer.socket.write('{"type":"cleanup"}\n'); }
        }
        if (edges.size === 0 && [...peers.values()].filter(peer => !peer.socket.destroyed).every(peer => peer.ack)) return !uncertain;
        await delay(20);
      }
      return false;
    },
    close() { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

const { files, extra, fileTimeoutMs } = JSON.parse(process.argv[2]);
let next = 0;
let failed = false;
const active = new Set();
function stop(child, group = true) {
  if (!child.pid) return false;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let confirmed = true;
  if (group && process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
    if (result.error || result.status !== 0) {
      console.error(`[test-file] taskkill failed: ${result.error?.message || `status ${result.status}`}`);
      confirmed = false;
    }
  } else if (group) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') {
        confirmed = false;
        console.error(`[test-file] process-group kill failed: ${error.message}`);
      }
    }
  }
  child.kill('SIGKILL');
  return confirmed;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const child of active) { unconfirmed('interrupted run'); stop(child); }
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const started = Date.now();
    console.error(`[test-file] START ${file}`);
    const registry = await control();
    const child = spawn(process.execPath, ['--test', '--test-timeout=300000', ...extra, file], {
      stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, ...registry.env },
    });
    active.add(child);
    let timedOut = false;
    let cleanup;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[test-file] TIMEOUT ${file} after ${fileTimeoutMs} ms; killing its process tree`);
      cleanup = (async () => {
        const confirmed = await registry.cleanup();
        if (!confirmed) unconfirmed(file);
        // Confirmed owners have already reaped every registered child. Only
        // the root handle remains; avoid signaling a now-empty/recycled PGID.
        if (!stop(child, !confirmed)) unconfirmed(file);
      })();
    }, fileTimeoutMs);
    const status = await new Promise(resolve => {
      child.once('error', error => { console.error(`[test-file] ${file}: ${error.message}`); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    clearTimeout(timer);
    let confirmed = true;
    if (cleanup) await cleanup;
    else if (!await registry.cleanup()) { confirmed = false; unconfirmed(file); }
    registry.close();
    active.delete(child);
    const ok = status === 0 && !timedOut && confirmed;
    if (!ok) failed = true;
    console.error(`[test-file] ${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - started} ms)`);
  }
}
await Promise.all(Array.from({ length: Math.min(files.length, Math.max(1, availableParallelism() - 1)) }, worker));
if (!cleanupUnconfirmed && process.env.ALP_TEST_RETAIN) unlinkSync(process.env.ALP_TEST_RETAIN);
process.exitCode = failed || cleanupUnconfirmed ? 1 : 0;
