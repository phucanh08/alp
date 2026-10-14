import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { webFile, createWebServer } from 'alp-paseo-plugin';

const run = promisify(execFile);

/** alpd's web server built without the ALP web app (ALPD §62 step 9; the app itself: paseo-web.test.js). */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-'));
  const home = path.join(directory, 'home');
  const web = createWebServer({ home, port: 0 });
  const info = await web.listen();
  t.after(async () => { await web.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { home, info, origin: `http://127.0.0.1:${info.port}` };
}

test('without the built app, alpd says how to build it at every address, on 127.0.0.1 only', async t => {
  const { home, info, origin } = await setup(t);
  assert.equal(info.url, `${origin}/`);
  assert.deepEqual(JSON.parse(await readFile(webFile(home), 'utf8')), info);
  assert.match(info.serverId, /^alp-[0-9a-f]{16}$/);
  for (const address of ['/', '/workspace/abc', '/app.js']) {
    const page = await fetch(`${origin}${address}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /built without the ALP web app[\s\S]*build-paseo-web\.mjs/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  }
  // DNS rebinding: a name that resolves here is still refused.
  const { stdout } = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: attacker.example', `${origin}/`]);
  assert.equal(stdout, '403');
  // No app, no socket.
  const refused = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, { headers: { Origin: origin } });
    ws.on('unexpected-response', (_request, response) => resolve(response.statusCode));
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {});
  });
  assert.equal(refused, 404);
});

test('settings may turn the web app off or move its port', () => {
  assert.doesNotThrow(() => validateUserSettings({ web: { enabled: false, port: 8000 } }, 'settings.json'));
  assert.throws(() => validateUserSettings({ web: { port: 80 } }, 'settings.json'), /web.port must be a port from 1024/);
  assert.throws(() => validateUserSettings({ web: { host: '0.0.0.0' } }, 'settings.json'), /unsupported web field 'host'/);
  // The classic page of ALPD §61 is gone; the app is Paseo's.
  assert.throws(() => validateUserSettings({ web: { app: 'classic' } }, 'settings.json'), /unsupported web field 'app'/);
});
