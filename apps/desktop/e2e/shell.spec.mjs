/**
 * The desktop shell end to end (docs/alp/desktop.md): the real Electron app, driven by Playwright's
 * `_electron`, against a disposable alp web host and a fake `alp` (./support.mjs). Run with
 * `bun run e2e` in apps/desktop after building packages/cli (`node scripts/build-workspace.mjs cli`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { appCopy, closeWindows, connectAgain, connectedTo, fakeAlp, freePort, host, inPage, launch, only, scratch, secondInstance, waitFor, windows } from './support.mjs';

const limit = { timeout: 120_000 };

/** A host on a free port and a fake alp that prints its address. */
async function connectedSetup(t) {
  const context = await scratch(t);
  const web = await host(t, context);
  await web.start(await freePort());
  const alp = await fakeAlp(context);
  await alp.prints(web.address);
  return { context, web, alp };
}

/** Polls the single window's page while `during` runs, and returns every bundled page it showed. */
async function pagesShown(electronApp, during) {
  const seen = new Set();
  let done = false;
  const watcher = (async () => {
    while (!done) {
      const state = await only(electronApp).catch(() => undefined);
      if (state?.page) seen.add(state.page);
      await sleep(50);
    }
  })();
  try { await during(); } finally { done = true; await watcher; }
  return seen;
}

test('connects to alp web, and apps/web takes the token out of the address', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  assert.equal(await inPage(app, 'location.hash'), '');
  assert.equal(await inPage(app, "sessionStorage.getItem('alp-web:link-token')") === web.web.token, true, 'apps/web kept the link token in the tab only');
});

test('no alp: the install page names the path that was tried', limit, async t => {
  const context = await scratch(t);
  const missing = path.join(context.dir, 'nowhere', 'alp');
  const app = await launch(t, context, missing);
  const state = await waitFor(async () => { const s = await only(app); return s?.page === 'missing-alp.html' && s.visible ? s : undefined; }, 'the missing-alp page');
  assert.equal(state.visible, true);
  assert.match(await inPage(app, 'document.body.innerText'), /npm install -g/);
  assert.ok((await inPage(app, 'document.body.innerText')).includes(missing));
});

test("alp's own error is shown as is, without its error: prefix", limit, async t => {
  const context = await scratch(t);
  const alp = await fakeAlp(context);
  await alp.set("echo 'error: alp web is disabled (web.enabled is false)' >&2; exit 1");
  const app = await launch(t, context, alp.file);
  await waitFor(async () => (await only(app))?.page === 'error.html', 'the error page');
  const text = await inPage(app, 'document.body.innerText');
  assert.ok(text.includes('alp web is disabled (web.enabled is false)'), text);
  assert.ok(!text.includes('error: alp web'), text);
});

test('a window reopened from the Dock during a connect shows that connect, once', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  await alp.prints(web.address, 3);
  const app = await launch(t, context, alp.file);
  await waitFor(async () => (await only(app))?.page === 'connecting.html', 'Connecting');
  await closeWindows(app);
  await waitFor(async () => (await windows(app)).length === 0, 'no window');
  await app.evaluate(({ app: electron }) => { electron.emit('activate'); });
  await connectedTo(app, web.origin);
  // The first connect's alp answers too; it was superseded and must not open or change anything.
  await sleep(3500);
  const list = await windows(app);
  assert.equal(list.length, 1);
  assert.equal(list[0].origin, web.origin);
});

test('File › Connect again with every window closed opens one and connects', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  await closeWindows(app);
  await waitFor(async () => (await windows(app)).length === 0, 'no window');
  await connectAgain(app);
  await connectedTo(app, web.origin);
});

test('L1: the failure of a superseded load does not cover a newer connect', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  // A server that accepts and never answers: the first connect's load hangs on it.
  const sockets = new Set();
  const hole = http.createServer(() => { /* never answers */ });
  hole.on('connection', socket => sockets.add(socket));
  await new Promise(resolve => hole.listen(0, '127.0.0.1', resolve));
  context.defer(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); hole.close(resolve); }));
  const holeAddress = web.address.replace(/:\d+\//, `:${hole.address().port}/`);
  await alp.prints(holeAddress);
  const app = await launch(t, context, alp.file);
  await waitFor(() => sockets.size > 0, 'the first load to reach the hanging server');
  await alp.prints(web.address, 2);
  const shown = await pagesShown(app, async () => {
    await connectAgain(app);
    // The first load now fails for real (connection reset), while the second connect is running.
    for (const socket of sockets) socket.destroy();
    await connectedTo(app, web.origin);
  });
  assert.ok(!shown.has('error.html'), `pages shown: ${[...shown].join(', ')}`);
});

test('L2: a first page that fails to load still shows the window', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const copy = await appCopy(context);
  await rm(path.join(copy, 'dist', 'pages', 'connecting.html'));
  await alp.prints(web.address, 4);
  const app = await launch(t, context, alp.file, { app: copy });
  // While alp still runs, the Connecting page is missing, so it never paints; the window shows anyway.
  await waitFor(async () => (await only(app))?.visible, 'a visible window while alp runs', 3500);
  await connectedTo(app, web.origin);
});

test('L3: opening the app again with no window open opens one and connects', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  await closeWindows(app);
  await waitFor(async () => (await windows(app)).length === 0, 'no window');
  const code = await secondInstance(context, alp.file);
  assert.equal(code, 0, 'the second instance hands over and quits');
  await connectedTo(app, web.origin);
});

test('alp web restarting on another port: the window follows it', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const before = web.origin;
  await web.stop();
  await web.start(await freePort());
  assert.notEqual(web.origin, before);
  await alp.prints(web.address);
  await connectedTo(app, web.origin, 60_000);
  assert.equal(await inPage(app, "sessionStorage.getItem('alp-web:link-token')") === web.web.token, true);
});

test('alp web rotate: the window reloads with the new token', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const old = web.web.token;
  const port = web.web.port;
  await web.stop();
  await web.rotate();
  await web.start(port);
  assert.notEqual(web.web.token, old);
  await alp.prints(web.address);
  await waitFor(async () => (await only(app))?.origin === web.origin && await inPage(app, `sessionStorage.getItem('alp-web:link-token') === ${JSON.stringify(web.web.token)}`), 'the window on the rotated token', 60_000);
  assert.equal(await inPage(app, 'location.hash'), '');
});
