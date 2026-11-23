/**
 * The desktop shell end to end (docs/alp/desktop.md): the real Electron app, driven by Playwright's
 * `_electron`, against a disposable alp dashboard host and a fake `alp` (./support.mjs). Run with
 * `bun run e2e` in apps/desktop after building packages/cli (`node scripts/build-workspace.mjs cli`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP, appCopy, closeWindows, connectAgain, connectedTo, fakeAlp, freePort, host, inPage, launch, only, scratch, secondInstance, waitFor, windows } from './support.mjs';

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

test('connects to alp dashboard, and apps/web takes the token out of the address', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  assert.equal(await inPage(app, 'location.hash'), '');
  assert.equal(await inPage(app, "sessionStorage.getItem('alp-web:link-token')") === web.web.token, true, 'apps/web kept the link token in the tab only');
});

test('t-81b0.7: the alp dashboard page can neither load nor open a bundled page', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const asStylesheet = `new Promise(resolve => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'alp-page://app/page.css'; link.onload = () => resolve('loaded'); link.onerror = () => resolve('refused'); document.head.append(link); })`;
  assert.equal(await inPage(app, asStylesheet), 'refused');
  await inPage(app, "location.href = 'alp-page://app/error.html'; window.open('alp-page://app/error.html'); 1");
  await sleep(1000);
  const list = await windows(app);
  assert.equal(list.length, 1, 'no window opened');
  assert.equal(list[0].origin, web.origin, 'the window stays on alp dashboard');
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
  await alp.set("echo 'error: alp dashboard is disabled (dashboard.enabled is false)' >&2; exit 1");
  const app = await launch(t, context, alp.file);
  await waitFor(async () => (await only(app))?.page === 'error.html', 'the error page');
  const text = await inPage(app, 'document.body.innerText');
  assert.ok(text.includes('alp dashboard is disabled (dashboard.enabled is false)'), text);
  assert.ok(!text.includes('error: alp dashboard'), text);
});

test('t-81b0.7: a build whose source tree is gone still shows its pages, and an alp without `alp dashboard` is named', limit, async t => {
  // The packaged app runs on a machine without the tree it was built from: build a copy, remove its
  // source, then run it. A bundle that looks for its pages in the source tree shows a blank window.
  const context = await scratch(t);
  // The repository's layout: the build copies ../../install.sh into dist (t-81b0.8).
  const build = path.join(context.dir, 'apps', 'desktop');
  await mkdir(build, { recursive: true });
  await cp(path.join(APP, 'package.json'), path.join(build, 'package.json'));
  await cp(path.join(APP, 'src'), path.join(build, 'src'), { recursive: true });
  await cp(path.join(APP, '..', '..', 'install.sh'), path.join(context.dir, 'install.sh'));
  await promisify(execFile)('bun', ['run', 'build'], { cwd: build, timeout: 60_000 });
  await rm(path.join(build, 'src'), { recursive: true });
  await rm(path.join(context.dir, 'install.sh'));
  assert.equal(await readFile(path.join(build, 'dist', 'install.sh'), 'utf8'), await readFile(path.join(APP, '..', '..', 'install.sh'), 'utf8'), 'the build ships the repository\'s install.sh');
  const alp = await fakeAlp(context);
  // What 0.0.1-beta.8 answers: its usage on stderr, exit 1 (no `dashboard` command); --version works.
  await alp.set("printf 'Usage:\\n  alp web [--print]\\n' >&2; exit 1");
  await alp.setVersion('0.0.1-beta.8');
  const app = await launch(t, context, alp.file, { app: build });
  await waitFor(async () => { const s = await only(app); return s?.page === 'error.html' && s.visible; }, 'the error page');
  assert.equal(await inPage(app, "document.querySelector('h1')?.textContent"), 'ALP could not open');
  assert.equal(await inPage(app, 'location.origin + location.pathname'), 'alp-page://app/error.html');
  // page.css applied and page.js ran (it fills the message in): both came through the same scheme.
  assert.equal(await inPage(app, 'getComputedStyle(document.body).display'), 'grid');
  const text = await inPage(app, 'document.body.innerText');
  assert.ok(text.includes(`Your alp 0.0.1-beta.8 (${alp.file}) has no \`alp dashboard\``), text);
  assert.ok(!text.includes('Usage:'), text);
});

test('a window reopened from the Dock during a connect shows the newer connect, and the older one is dropped', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  // The first connect's alp answers only when released, with an address nothing listens on: if its
  // result were used, the window would load it and show the error page.
  const dead = web.address.replace(/:\d+\//, `:${await freePort(web.web.port)}/`);
  const first = await alp.firstGated(dead, web.address);
  const app = await launch(t, context, alp.file);
  await waitFor(async () => (await only(app))?.page === 'connecting.html', 'Connecting');
  await waitFor(first.firstStarted, 'the first connect to run alp');
  await closeWindows(app);
  await waitFor(async () => (await windows(app)).length === 0, 'no window');
  const shown = await pagesShown(app, async () => {
    await app.evaluate(({ app: electron }) => { electron.emit('activate'); });
    await connectedTo(app, web.origin);
    // Only now does the first connect's alp answer: strictly after the newer connect loaded.
    await first.release();
    await waitFor(first.firstDone, 'the first alp to answer');
    // Its result reaches connect() at once; a wrongly kept one would load the dead address and
    // show the error page within this margin.
    await sleep(1000);
  });
  assert.ok(!shown.has('error.html'), `pages shown: ${[...shown].join(', ')}`);
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

test('L1: a superseded connect that ends with a failing load does not cover the newer connect', limit, async t => {
  // Connect again aborts the first connect's navigation at once (ERR_ABORTED, ignored), so the stale
  // case that can really happen is the older connect's result arriving after the newer one: it must
  // be dropped, not loaded (its address refuses connections, so loading it would show the error page).
  const { context, web, alp } = await connectedSetup(t);
  const dead = web.address.replace(/:\d+\//, `:${await freePort(web.web.port)}/`);
  const first = await alp.firstGated(dead, web.address);
  const app = await launch(t, context, alp.file);
  await waitFor(async () => (await only(app))?.page === 'connecting.html', 'Connecting');
  await waitFor(first.firstStarted, 'the first connect to run alp');
  const shown = await pagesShown(app, async () => {
    await connectAgain(app);
    await connectedTo(app, web.origin);
    // Only now does the first connect's alp answer: strictly after the newer connect loaded.
    await first.release();
    await waitFor(first.firstDone, 'the first alp to answer');
    // Its result reaches connect() at once; a wrongly kept one would load the dead address and
    // show the error page within this margin.
    await sleep(1000);
  });
  assert.ok(!shown.has('error.html'), `pages shown: ${[...shown].join(', ')}`);
  assert.equal((await only(app))?.origin, web.origin);
});

test('L2: a first page that fails to load still shows the window', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const copy = await appCopy(context);
  await rm(path.join(copy, 'dist', 'pages', 'connecting.html'));
  await alp.prints(web.address, 12);
  const app = await launch(t, context, alp.file, { app: copy });
  // While alp still runs (12 s), the Connecting page is missing, so it never paints; the window shows anyway.
  const state = await waitFor(async () => { const s = await only(app); return s?.visible ? s : undefined; }, 'a visible window while alp runs', 6000);
  assert.notEqual(state.origin, web.origin, 'shown before alp answered');
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

test('alp dashboard restarting on another port: the window follows it', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const before = web.origin;
  await web.stop();
  await web.start(await freePort(Number(new URL(before).port)));
  assert.notEqual(web.origin, before);
  await alp.prints(web.address);
  await connectedTo(app, web.origin, 60_000);
  assert.equal(await inPage(app, "sessionStorage.getItem('alp-web:link-token')") === web.web.token, true);
});

test('alp dashboard rotate: the window reloads with the new token', limit, async t => {
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

test('t-cee3: alp dashboard restarting on the same port with a fresh token: the window runs --print again and reconnects', limit, async t => {
  // Every start mints a new credential and revokes the old one (t-cee3), with no `alp dashboard rotate`.
  // The fake alp asks the live service over its token socket, as the real `alp dashboard --print`
  // does, so nothing but the app re-running it can bring the window the new token.
  const context = await scratch(t);
  const web = await host(t, context);
  await web.start(await freePort());
  const alp = await fakeAlp(context);
  const live = await alp.printsLive(web.home);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const old = web.web.token;
  const origin = web.origin;
  assert.equal(await inPage(app, `sessionStorage.getItem('alp-web:link-token') === ${JSON.stringify(old)}`), true);
  const runsBefore = await live.runs();
  await web.stop();
  await web.start(web.web.port);
  assert.equal(web.origin, origin, 'the same port');
  assert.notEqual(web.web.token, old, 'a new start minted a new token');
  assert.equal(await ticketStatus(origin, old), 401, 'the token of the last start is refused at the ticket endpoint');
  await waitFor(async () => (await only(app))?.origin === origin && await inPage(app, `sessionStorage.getItem('alp-web:link-token') === ${JSON.stringify(web.web.token)}`), 'the window on the new start\'s token', 60_000);
  assert.ok(await live.runs() > runsBefore, 'the app ran `alp dashboard --print` again');
  assert.equal(await inPage(app, 'location.hash'), '');
  assert.equal((await only(app))?.page, undefined, 'no bundled (error) page');
  assert.equal(await ticketStatus(origin, web.web.token), 201, 'the token the window holds is live');
});

/** POST /v1/tickets with `token`: 201 for a live credential, 401 otherwise. */
async function ticketStatus(origin, token) {
  const response = await fetch(`${origin}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await response.body?.cancel();
  return response.status;
}
