// The browser bundle's import boundary (build/browser-boundary.ts), on Vite's real module graph:
// the app's own build holds only the portable SDK, and an entry that reaches the Node client
// through another file fails the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { boundaryProblem, browserBoundary } from '../build/browser-boundary.ts';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(web, '../..');

test('module ids: the portable SDK passes; host code, Node built-ins and Paseo fail', () => {
  const ok = ['packages/client/dist/portable.js', 'packages/client/dist/connection/websocket.js', 'packages/client/dist/rpc/connection/reconnect.js', 'packages/protocol/dist/wire.js', 'apps/web/src/lib/controller.js', 'node_modules/react/index.js'];
  for (const file of ok) assert.equal(boundaryProblem(path.join(repository, file), repository), undefined, file);
  const bad = ['packages/client/dist/index.js', 'packages/client/dist/connection/ipc.js', 'packages/core/src/tasks/records/tasks.ts', 'packages/runtime/src/runtime.ts', 'packages/daemon/dist/alpd.js', 'packages/protocol/dist/contract.js', 'apps/gateway/src/policy.js', 'integrations/paseo/server/index.ts', 'node_modules/ws/index.js', 'node_modules/@getpaseo/client/index.js'];
  for (const file of bad) assert.ok(boundaryProblem(path.join(repository, file), repository), file);
  assert.ok(boundaryProblem('\0__vite-browser-external:node:fs', repository));
});

test('a transitive import of the Node client fails the build', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'alp-web-boundary-'));
  try {
    await assert.rejects(build({
      configFile: false, root: web, logLevel: 'silent',
      plugins: [browserBoundary({ repository })],
      build: { outDir: out, write: false, rollupOptions: { input: path.join(web, 'tests/fixtures/forbidden-entry.ts') } },
    }), /portable/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('the app build lists only portable SDK modules', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'alp-web-build-'));
  try {
    await build({ configFile: path.join(web, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    const { alpModules }: { alpModules: string[] } = JSON.parse(await readFile(path.join(out, 'alp-boundary.json'), 'utf8'));
    assert.ok(alpModules.includes('packages/client/dist/portable.js'));
    assert.ok(alpModules.every(file => /^packages\/(client\/dist\/(portable|connection\/websocket|rpc\/)|protocol\/dist\/(public|wire)\.js)/.test(file)), alpModules.join(', '));
  } finally { await rm(out, { recursive: true, force: true }); }
});
