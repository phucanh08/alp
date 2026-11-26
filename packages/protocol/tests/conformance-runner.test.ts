import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runConformance } from '../conformance/run.mjs';
const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../conformance/run.mjs', import.meta.url));

test('unknown and empty profile selections are rejected before connecting', async () => {
  for (const profiles of [[], ['wrie'], ['wire', 'typo']]) {
    await assert.rejects(runConformance({ socket: 'missing', profiles }), /profile/i);
  }
});

test('CLI follows symlinks and importing from a same-named wrapper has no CLI effects', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'conf-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'runner.mjs');
  await symlink(runner, link);
  await assert.rejects(exec(process.execPath, [link, '--socket', 'missing', '--profiles', 'typo']), error => error.code !== 0 && /profile/i.test(error.stderr));
  await mkdir(path.join(dir, 'conformance'));
  const wrapper = path.join(dir, 'conformance/run.mjs');
  await writeFile(wrapper, `import ${JSON.stringify(new URL('../conformance/run.mjs', import.meta.url).href)}; console.log('imported');`);
  const { stdout } = await exec(process.execPath, [wrapper, '--wrapper-option']);
  assert.equal(stdout.trim(), 'imported');
});

test('malformed JSON values and duplicate responses fail cases without crashing the host', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'conf-wire-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\conf-${process.pid}-${Date.now()}` : path.join(dir, 's');
  let malformed = false;
  const server = net.createServer(connection => {
    let buffer = '';
    connection.on('error', () => {});
    connection.on('data', chunk => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let request; try { request = JSON.parse(line); } catch { continue; }
        const result = { protocolVersion: 1, daemonVersion: 'test', pid: 1, capabilities: [] };
        const reply = JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n';
        connection.write(malformed ? 'null\n42\n"bad"\n' + reply : reply + reply);
      }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const badValues of [false, true]) {
    malformed = badValues;
    const results = await runConformance({ socket, profiles: ['handshake'] });
    assert.equal(results.find(result => result.id === 'handshake.repeat').ok, false);
    assert.match(results.find(result => result.id === 'handshake.repeat').error, badValues ? /invalid|object/ : /unexpected|duplicate/);
  }
});
