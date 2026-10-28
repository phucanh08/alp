import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { webFile, createWebServer } from '@anhlp/alp-paseo';

/** The Paseo integration's local listener (ALPD §62): a token-guarded socket, no page (paseo-web was removed in t-55ce.3). */
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-'));
  const home = path.join(directory, 'home');
  const web = createWebServer({ home, port: 0, ...options });
  const info = await web.listen();
  t.after(async () => { await web.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { home, info, origin: `http://127.0.0.1:${info.port}` };
}

/** The status of an upgrade to /ws, or 'open'. */
const upgrade = (info, headers) => new Promise(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, { headers });
  ws.on('unexpected-response', (_request, response) => resolve(response.statusCode));
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('error', () => {});
});

test('the listener serves no page at any address, on 127.0.0.1 only, and without the bridge refuses the socket', async t => {
  const { home, info, origin } = await setup(t);
  assert.equal(info.url, `${origin}/`);
  assert.deepEqual(JSON.parse(await readFile(webFile(home), 'utf8')), info);
  assert.match(info.serverId, /^alp-[0-9a-f]{16}$/);
  for (const address of ['/', '/workspace/abc', '/index.html', '/alp-plugins.js', '/_expo/static/js/web/index-1.js']) {
    const page = await fetch(`${origin}${address}`);
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /^text\/plain/);
    assert.match(await page.text(), /not a web page[\s\S]*alp web/);
    assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  }
  assert.equal((await fetch(`${origin}/`, { method: 'POST' })).status, 405);
  // DNS rebinding: a name that resolves here is still refused.
  // fetch cannot set Host, so this goes through node:http.
  const status = await new Promise((resolve, reject) => get(`${origin}/`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(status, 403);
  // No bridge, no socket.
  assert.equal(await upgrade(info, {}), 404);
});

test('with the bridge, the socket opens only without a browser Origin and with its loopback host; pages stay 404', async t => {
  const attached = [];
  const gateway = { attach: (ws, options) => { attached.push(options); ws.close(); } };
  const { info, origin } = await setup(t, { gateway });
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal(await upgrade(info, { Origin: 'http://attacker.example' }), 403);
  assert.equal(await upgrade(info, { Origin: 'null' }), 403);
  assert.equal(await upgrade(info, { Origin: '' }), 403);
  assert.equal(await upgrade(info, { Host: 'attacker.example' }), 403);
  assert.equal(await upgrade(info, { Origin: origin }), 403);
  assert.equal(await upgrade(info, { Origin: `http://localhost:${info.port}` }), 403);
  assert.equal(await upgrade(info, {}), 'open');
  assert.equal(attached.length, 1);
  // The deprecated `app` option still names the bridge for one release; its `dir` is ignored.
  const legacy = await setup(t, { app: { dir: '/nonexistent', gateway } });
  assert.equal(await upgrade(legacy.info, {}), 'open');
  assert.equal((await fetch(`${legacy.origin}/`)).status, 404);
});

test('the integration records itself in paseo.json and carries over only its own pre-rename web.json identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const start = async (home, legacy) => {
    await mkdir(home, { recursive: true });
    if (legacy) await writeFile(path.join(home, 'web.json'), JSON.stringify(legacy));
    const web = createWebServer({ home });
    const info = await web.listen();
    await web.close();
    return info;
  };
  const old = { port: 7433, token: 'a'.repeat(64), serverId: 'alp-0123456789abcdef', url: 'http://127.0.0.1:7433/', pid: 1 };
  const carried = path.join(directory, 'carried');
  const info = await start(carried, old);
  assert.equal(webFile(carried), path.join(carried, 'paseo.json'));
  assert.deepEqual(JSON.parse(await readFile(webFile(carried), 'utf8')), info);
  assert.deepEqual([info.token, info.serverId], [old.token, old.serverId], 'a paired device keeps its password across the rename');
  assert.deepEqual(JSON.parse(await readFile(path.join(carried, 'web.json'), 'utf8')), old, 'web.json is never written');
  assert.ok(info.port > 0 && info.port !== 7433, 'the default listener is ephemeral, not web.port');
  // alp-web's own web.json is not the integration's identity.
  const alpWeb = path.join(directory, 'alp-web');
  const fresh = await start(alpWeb, { ...old, app: 'alp-web' });
  assert.notEqual(fresh.token, old.token);
  assert.notEqual(fresh.serverId, old.serverId);
  // Once paseo.json exists it wins over web.json.
  const again = await start(carried, { ...old, token: 'b'.repeat(64) });
  assert.equal(again.token, old.token);
});

test('settings may turn the web app off or move its port', () => {
  assert.doesNotThrow(() => validateUserSettings({ web: { enabled: false, port: 8000 } }, 'settings.json'));
  assert.throws(() => validateUserSettings({ web: { port: 80 } }, 'settings.json'), /web.port must be a port from 1024/);
  assert.throws(() => validateUserSettings({ web: { host: '0.0.0.0' } }, 'settings.json'), /unsupported web field 'host'/);
  // The classic page of ALPD §61 is gone; `alp web` serves apps/web.
  assert.throws(() => validateUserSettings({ web: { app: 'classic' } }, 'settings.json'), /unsupported web field 'app'/);
});
