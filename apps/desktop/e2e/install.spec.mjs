/**
 * t-81b0.8: the app installs ALP when it finds none (docs/alp/desktop.md §4). The real Electron app,
 * unpackaged, with a scratch HOME, ALP_HOME and TMPDIR, a fake login shell that finds no alp, and a
 * local release mirror (./support.mjs releaseMirror) read through file:// by the app's bundled
 * install.sh: no network. The fake bundle's `alp dashboard --print` prints a disposable alp dashboard
 * host's address, so a finished install ends on alp dashboard.
 *
 * The last test installs a REAL release from a local copy of its assets, and only when
 * ALP_DESKTOP_E2E_RELEASE_MIRROR names that directory (SHA256SUMS and the darwin archives).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { connectedTo, freePort, host, inPage, launch, noAlpEnv, only, releaseMirror, scratch, waitFor } from './support.mjs';

const exec = promisify(execFile);
const limit = { timeout: 180_000 };
const exists = file => lstat(file).then(() => true, () => false);

/** The app with no alp anywhere, installing from `mirror` (a directory). */
async function launchWithout(t, context, mirror) {
  const app = await launch(t, context, undefined, { env: { ...(await noAlpEnv(context)), ALP_DESKTOP_INSTALL_MIRROR: mirror } });
  const home = path.join(context.dir, 'app-home');
  return { app, home, alpRoot: path.join(home, '.alp'), tmp: path.join(context.dir, 'tmp') };
}

/** Waits for bundled page `name` in the single window, and returns its text. */
async function pageText(app, name, match = /./, timeoutMs = 30_000) {
  return waitFor(async () => {
    const state = await only(app);
    if (state?.page !== name || !state.visible) return undefined;
    const text = await inPage(app, 'document.body.innerText');
    return match.test(text) ? text : undefined;
  }, `${name} matching ${match}`, timeoutMs);
}

const click = (app, id) => inPage(app, `document.getElementById(${JSON.stringify(id)}).click(); 1`);

/** install.sh's temporary directories are gone (it removes its own on exit). */
async function noInstallerLeft(tmp) {
  assert.deepEqual((await readdir(tmp)).filter(name => name.startsWith('alp-install.')), []);
}

test('no alp: the confirmation page names version and paths, nothing is written before Install, then the window opens alp dashboard', limit, async t => {
  const context = await scratch(t);
  const web = await host(t, context);
  await web.start(await freePort());
  const mirror = await releaseMirror(context, { address: web.address });
  const { app, home, alpRoot, tmp } = await launchWithout(t, context, mirror.dir);

  const text = await pageText(app, 'install.html', /Install ALP 9\.8\.7\?/);
  for (const expected of [
    `file://${mirror.dir}`, 'alp-9.8.7-darwin-',
    path.join(alpRoot, 'app', '9.8.7'), path.join(alpRoot, 'bin', 'alp'), alpRoot,
  ]) assert.ok(text.includes(expected), `the page states ${expected}:\n${text}`);
  // The page waits for the user: nothing exists until Install.
  await sleep(1500);
  assert.equal(await exists(alpRoot), false, 'nothing is written before Install');

  await click(app, 'install-button');
  await connectedTo(app, web.origin, 60_000);

  assert.equal((await stat(alpRoot)).mode & 0o777, 0o700, 'the ALP home is private, as alpd requires');
  assert.equal(await readlink(path.join(alpRoot, 'bin', 'alp')), path.join(alpRoot, 'app', 'current', 'bin', 'alp'));
  assert.equal(await readlink(path.join(alpRoot, 'app', 'current')), '9.8.7');
  for (const profile of ['.zshrc', '.bash_profile', '.bashrc', '.profile']) assert.equal(await exists(path.join(home, profile)), false, `${profile} not written`);
  await noInstallerLeft(tmp);
});

test('a tampered archive (checksum mismatch) is refused, shown, and nothing is installed', limit, async t => {
  const context = await scratch(t);
  const mirror = await releaseMirror(context, { address: 'http://127.0.0.1:9/#token=unused' });
  await mirror.tamper();
  const { app, alpRoot, tmp } = await launchWithout(t, context, mirror.dir);
  await pageText(app, 'install.html', /Install ALP 9\.8\.7\?/);
  await click(app, 'install-button');
  const text = await pageText(app, 'error.html', /checksum mismatch/, 60_000);
  assert.match(text, /Installing ALP 9\.8\.7 failed: checksum mismatch for alp-9\.8\.7-darwin-/);
  assert.match(text, /ALP 9\.8\.7 was not installed/);
  assert.equal(await exists(alpRoot), false, 'nothing under the ALP home');
  await noInstallerLeft(tmp);
});

test('a failed download is shown, and nothing is installed', limit, async t => {
  const context = await scratch(t);
  const mirror = await releaseMirror(context, { address: 'http://127.0.0.1:9/#token=unused' });
  await mirror.dropArchives();
  const { app, alpRoot, tmp } = await launchWithout(t, context, mirror.dir);
  await pageText(app, 'install.html', /Install ALP 9\.8\.7\?/);
  await click(app, 'install-button');
  assert.match(await pageText(app, 'error.html', /could not download/, 60_000), /Installing ALP 9\.8\.7 failed: could not download/);
  assert.equal(await exists(alpRoot), false);
  await noInstallerLeft(tmp);
});

test('Cancel installs nothing and says how to be asked again; Connect again offers it again', limit, async t => {
  const context = await scratch(t);
  const mirror = await releaseMirror(context, { address: 'http://127.0.0.1:9/#token=unused' });
  const { app, alpRoot } = await launchWithout(t, context, mirror.dir);
  await pageText(app, 'install.html', /Install ALP 9\.8\.7\?/);
  await click(app, 'cancel-button');
  assert.match(await pageText(app, 'missing-alp.html', /Nothing was installed/), /Connect again/);
  await sleep(1000);
  assert.equal(await exists(alpRoot), false);
  // An answer replayed from the old page's nonce does nothing now.
  await inPage(app, "location.href = 'alp-page://app/confirm?action=install&nonce=' + 'stale'; 1");
  await sleep(500);
  assert.equal((await only(app))?.page, 'missing-alp.html');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(i => i.label === 'File')?.submenu?.items.find(i => i.label === 'Connect again')?.click());
  await pageText(app, 'install.html', /Install ALP 9\.8\.7\?/);
  assert.equal(await exists(alpRoot), false);
});

test('a release the app cannot read is shown on the install page, with the terminal command', limit, async t => {
  const context = await scratch(t);
  const mirror = await releaseMirror(context, { address: 'http://127.0.0.1:9/#token=unused' });
  await mirror.dropSums();
  const { app, alpRoot } = await launchWithout(t, context, mirror.dir);
  const text = await pageText(app, 'missing-alp.html', /Could not read the latest ALP release/);
  assert.ok(text.includes(`file://${mirror.dir}/SHA256SUMS`), text);
  assert.match(text, /install\.sh \| sh/);
  assert.equal(await exists(alpRoot), false);
});

const RELEASE_MIRROR = process.env.ALP_DESKTOP_E2E_RELEASE_MIRROR;

test('a real release installs from its own assets, alpd starts under the scratch ALP home, and the window opens alp dashboard', { ...limit, timeout: 600_000, skip: !RELEASE_MIRROR && 'set ALP_DESKTOP_E2E_RELEASE_MIRROR to a directory holding a release\'s SHA256SUMS and darwin archives' }, async t => {
  const context = await scratch(t);
  const { app, alpRoot, tmp } = await launchWithout(t, context, path.resolve(RELEASE_MIRROR));
  const alp = path.join(alpRoot, 'bin', 'alp');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.dirname(alpRoot), ALP_HOME: alpRoot, TMPDIR: tmp };
  // Registered after the app (so undone before it closes): stop the scratch alp dashboard and alpd,
  // each only after its status names this scratch home.
  context.defer(async () => {
    if (!await exists(alp)) return;
    const status = await exec(alp, ['daemon', 'status'], { env }).then(r => r.stdout, e => `${e.stdout}${e.stderr}`);
    t.diagnostic(`alp daemon status before stop: ${status.trim()}`);
    if (status.includes('socket ') && !status.includes(`socket ${alpRoot}`)) throw new Error(`alpd status names another home; not stopping it: ${status}`);
    await exec(alp, ['dashboard', '--stop'], { env }).catch(error => t.diagnostic(`dashboard --stop: ${error.message}`));
    await exec(alp, ['daemon', 'stop'], { env }).catch(error => t.diagnostic(`daemon stop: ${error.message}`));
  });
  const text = await pageText(app, 'install.html', /Install ALP \S+\?/);
  t.diagnostic(text.split('\n').slice(0, 12).join(' | '));
  await click(app, 'install-button');
  await waitFor(async () => {
    const state = await only(app);
    if (state?.page === 'error.html') throw new Error(await inPage(app, 'document.body.innerText'));
    return state && !state.page && state.origin.startsWith('http://127.0.0.1:') && !state.token && state.visible;
  }, 'the window on alp dashboard', 300_000);
  assert.equal((await stat(alpRoot)).mode & 0o777, 0o700);
  const printed = await exec(alp, ['dashboard', '--print'], { env });
  assert.match(printed.stdout, /^http:\/\/127\.0\.0\.1:\d+\/#token=alpgw1\./);
  const status = (await exec(alp, ['daemon', 'status'], { env })).stdout;
  t.diagnostic(`alp daemon status: ${status.trim()}`);
  assert.ok(status.includes(`socket ${alpRoot}`), status);
});
