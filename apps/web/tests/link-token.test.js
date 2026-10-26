// The token in the address `alp web` opens (docs/alp/web.md §4.2): parsed from the fragment, taken
// out of the address at once, kept in this tab's sessionStorage (never localStorage), and what the
// controller does with it: a refused token is forgotten with a message to run `alp web` again, a
// socket the gateway closes with 4403 (grant changed) reconnects with the same token by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Controller } from '../src/lib/controller.js';
import { AuthenticationError, ConfigurationError, TransientError } from '../src/lib/errors.js';
import { LINK_NOT_LOOPBACK, LINK_TOKEN_INVALID, LINK_TOKEN_KEY, LINK_TOKEN_MALFORMED, isLinkToken, isLoopbackPage, parseLinkHash, storedLinkToken, takeLinkToken } from '../src/lib/link-token.js';
import { FakeHost, until } from './support/fake-host.js';

const TOKEN = `alpgw1.0123456789abcdef.${'A'.repeat(42)}w`;
const OTHER = `alpgw1.fedcba9876543210.${'b_-'.repeat(14)}x`;

/** A Storage stand-in that records every call. */
function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  const calls = [];
  return {
    items, calls,
    getItem(key) { calls.push(['get', key]); return items.has(key) ? items.get(key) : null; },
    setItem(key, value) { calls.push(['set', key]); items.set(key, String(value)); },
    removeItem(key) { calls.push(['remove', key]); items.delete(key); },
  };
}

/** A page at `href` with a history that records replaceState. */
function page(href) {
  const url = new URL(href);
  const replaced = [];
  const location = { hash: url.hash, pathname: url.pathname, search: url.search, origin: url.origin, protocol: url.protocol, hostname: url.hostname };
  const history = { state: { kept: true }, replaceState(data, unused, next) { replaced.push({ data, unused, next }); location.hash = ''; } };
  return { location, history, replaced };
}

test('parseLinkHash finds an alpgw1 token in #token=, never echoes a malformed one', () => {
  assert.deepEqual(parseLinkHash(`#token=${TOKEN}`), { token: TOKEN });
  assert.deepEqual(parseLinkHash(`token=${TOKEN}`), { token: TOKEN });
  assert.deepEqual(parseLinkHash(`#view=x&token=${TOKEN}`), { token: TOKEN });
  assert.equal(parseLinkHash(''), undefined);
  assert.equal(parseLinkHash('#'), undefined);
  assert.equal(parseLinkHash('#section-2'), undefined);
  assert.equal(parseLinkHash('#tokens=x'), undefined);
  for (const bad of ['#token=', '#token=alpgw1.short.x', `#token=${TOKEN}x`, `#token=${TOKEN.toUpperCase()}`, `#token=alpgwt.${'a'.repeat(43)}`, `#token=${TOKEN.replace('alpgw1', 'alpgw2')}`, `#token=%20${TOKEN}`]) {
    const parsed = parseLinkHash(bad);
    assert.deepEqual(parsed, { malformed: true }, bad);
    assert.equal(JSON.stringify(parsed).includes('alpgw'), false);
  }
  assert.equal(isLinkToken(TOKEN), true);
  assert.equal(isLinkToken(OTHER), true);
  assert.equal(isLinkToken(undefined), false);
});

test('isLoopbackPage: http on 127.0.0.1 or localhost only', () => {
  assert.equal(isLoopbackPage(new URL('http://127.0.0.1:7433/')), true);
  assert.equal(isLoopbackPage(new URL('http://localhost:7433/')), true);
  assert.equal(isLoopbackPage(new URL('https://127.0.0.1:7433/')), false);
  assert.equal(isLoopbackPage(new URL('http://192.168.1.2:7433/')), false);
  assert.equal(isLoopbackPage(new URL('http://127.0.0.1.example.com/')), false);
  assert.equal(isLoopbackPage(new URL('https://alp.example.com/')), false);
});

test('a link token is taken out of the address first and kept in the tab storage', () => {
  const { location, history, replaced } = page(`http://127.0.0.1:7433/app?x=1#token=${TOKEN}`);
  const storage = memoryStorage();
  const start = takeLinkToken({ location, history, storage });
  assert.deepEqual(start, { url: 'http://127.0.0.1:7433', token: TOKEN });
  assert.deepEqual(replaced, [{ data: { kept: true }, unused: '', next: '/app?x=1' }], 'the same path and query, no fragment, history state kept');
  assert.equal(location.hash, '');
  assert.equal(storage.items.get(LINK_TOKEN_KEY), TOKEN);
  assert.equal(storage.calls.findIndex(call => call[0] === 'set') >= 0, true);
});

test('a reload without a fragment connects with the token this tab kept; a new link replaces it', () => {
  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const reload = page('http://127.0.0.1:7433/');
  assert.deepEqual(takeLinkToken({ ...reload, storage }), { url: 'http://127.0.0.1:7433', token: TOKEN });
  assert.deepEqual(reload.replaced, [], 'no fragment: the address is left alone');
  const fresh = page(`http://127.0.0.1:7433/#token=${OTHER}`);
  assert.deepEqual(takeLinkToken({ ...fresh, storage }), { url: 'http://127.0.0.1:7433', token: OTHER });
  assert.equal(storage.items.get(LINK_TOKEN_KEY), OTHER);
  // Something that is not a token in the slot is removed, not used.
  const junk = memoryStorage({ [LINK_TOKEN_KEY]: 'not-a-token' });
  assert.equal(storedLinkToken(junk), undefined);
  assert.equal(junk.items.has(LINK_TOKEN_KEY), false);
  // No link and nothing kept: the connect form as before.
  assert.equal(takeLinkToken({ ...page('http://127.0.0.1:7433/'), storage: memoryStorage() }), undefined);
  assert.equal(takeLinkToken({ ...page('http://127.0.0.1:7433/#about'), storage: memoryStorage() }), undefined);
});

test('a malformed or non-loopback link is stripped too, and neither kept nor used', () => {
  for (const [href, error] of [['http://127.0.0.1:7433/#token=alpgw1.nope', LINK_TOKEN_MALFORMED], [`https://alp.example.com/#token=${TOKEN}`, LINK_NOT_LOOPBACK], [`http://10.0.0.2:7433/#token=${TOKEN}`, LINK_NOT_LOOPBACK]]) {
    const { location, history, replaced } = page(href);
    const storage = memoryStorage();
    assert.deepEqual(takeLinkToken({ location, history, storage }), { error }, href);
    assert.equal(replaced.length, 1, href);
    assert.equal(location.hash, '');
    assert.equal(storage.items.size, 0, href);
    assert.equal(error.includes('alpgw1.'), false);
  }
  // Not on loopback, a kept token is not used either.
  assert.equal(takeLinkToken({ ...page('https://alp.example.com/'), storage: memoryStorage({ [LINK_TOKEN_KEY]: TOKEN }) }), undefined);
});

test('storage that throws (disabled) still connects this load', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(takeLinkToken({ ...page(`http://localhost:7433/#token=${TOKEN}`), storage: broken }), { url: 'http://localhost:7433', token: TOKEN });
  assert.equal(takeLinkToken({ ...page('http://localhost:7433/'), storage: broken }), undefined);
  assert.equal(takeLinkToken({ ...page(`http://localhost:7433/#token=${TOKEN}`), storage: undefined }).token, TOKEN);
});

test('main.tsx keeps the link token in sessionStorage, never in localStorage', async () => {
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /window\.sessionStorage/);
  assert.match(main, /linkStorage = tabStorage\(\)/);
  assert.match(main, /takeLinkToken\(\{ location: window\.location, history: window\.history, storage: linkStorage \}\)/);
  assert.match(main, /new Controller\(\{ storage: browserStorage\(\), linkStorage \}\)/);
  const source = await readFile(new URL('../src/lib/link-token.js', import.meta.url), 'utf8');
  assert.equal(/localStorage/.test(source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), false, 'link-token.js code never names localStorage');
});

// ---- the controller with a link token ---------------------------------------------------------

function setup(t, linkStorage) {
  const host = new FakeHost();
  const tokens = [];
  const open = options => { tokens.push(options.token); return host.open(options); };
  const controller = new Controller({ open, linkStorage, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, attentionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect({ keepLink: true }));
  const phases = [];
  controller.subscribe(() => phases.push(controller.getState().connection.phase));
  return { host, controller, tokens, phases, state: () => controller.getState() };
}

test('a socket closed with 4403 (grant changed) reconnects with the same token and adopts the new grant', async t => {
  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const w = setup(t, storage);
  w.controller.connect({ url: 'http://127.0.0.1:7433', token: TOKEN, link: true });
  await until(() => w.state().connection.phase === 'open' && w.state().principal, 'open');
  assert.equal(w.state().connection.link, true);
  assert.deepEqual(w.state().principal.workspaces, ['/w/a', '/w/b']);
  // alp-web's grant follows alpd's registry: a new project, then the gateway closes every socket of the credential.
  w.host.principal = { ...w.host.principal, workspaces: ['/w/a', '/w/b', '/w/c'], workspaceRoots: [...w.host.principal.workspaceRoots, { path: '/w/c', canonical: '/w/c' }] };
  const opens = w.host.opens;
  for (const connection of [...w.host.connections]) connection.end({ code: 4403, reason: 'credential grant changed' });
  await until(() => w.host.opens > opens && w.state().connection.phase === 'open' && w.state().principal?.workspaces.includes('/w/c'), 'reconnected under the new grant');
  assert.deepEqual(new Set(w.tokens), new Set([TOKEN]), 'every open used the same token');
  assert.equal(w.phases.includes('failed'), false, 'never shown the connect form');
  assert.equal(storage.items.get(LINK_TOKEN_KEY), TOKEN, 'still kept for a reload');
});

test('a link token the gateway refuses is forgotten, with a message to run alp web again', async t => {
  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const w = setup(t, storage);
  w.controller.connect({ url: 'http://127.0.0.1:7433', token: TOKEN, link: true });
  await until(() => w.state().connection.phase === 'open', 'open');
  // alp web rotate: the service restarts, the old token is refused.
  w.host.refuse = new AuthenticationError();
  w.host.drop();
  await until(() => w.state().connection.phase === 'failed', 'failed');
  assert.equal(w.state().connection.error.message, LINK_TOKEN_INVALID);
  assert.match(LINK_TOKEN_INVALID, /no longer valid.*alp web/);
  assert.equal(w.state().connection.error.message.includes(TOKEN), false);
  assert.equal(storage.items.has(LINK_TOKEN_KEY), false, 'a reload shows the form instead of trying it again');
  assert.equal(w.state().principal, null);
  assert.equal(w.state().connection.gateway, 'http://127.0.0.1:7433', 'the form offers the same address');
});

test('a refused link token on the first connection is forgotten the same way', async t => {
  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const w = setup(t, storage);
  w.host.refuse = new AuthenticationError();
  w.controller.connect({ url: 'http://127.0.0.1:7433', token: TOKEN, link: true });
  await until(() => w.state().connection.phase === 'failed', 'failed');
  assert.equal(w.state().connection.error.message, LINK_TOKEN_INVALID);
  assert.equal(storage.items.has(LINK_TOKEN_KEY), false);
});

test('a link waits for a host that is not up yet instead of failing; a form connection fails at once as before', async t => {
  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const w = setup(t, storage);
  w.host.refuse = new TransientError('Cannot reach the gateway.');
  w.controller.connect({ url: 'http://127.0.0.1:7433', token: TOKEN, link: true });
  await until(() => w.host.opens >= 3, 'retried');
  assert.equal(w.state().connection.phase, 'connecting');
  assert.equal(w.state().connection.link, true);
  assert.equal(w.state().connection.error?.message, 'Cannot reach the gateway.');
  w.host.refuse = undefined;
  await until(() => w.state().connection.phase === 'open', 'open once the host is up');
  assert.equal(w.phases.includes('failed'), false);

  const form = setup(t, memoryStorage());
  form.host.refuse = new TransientError('Cannot reach the gateway.');
  form.controller.connect({ url: 'http://127.0.0.1:7434', token: TOKEN });
  await until(() => form.state().connection.phase === 'failed', 'failed');
  assert.equal(form.host.opens, 1);
  assert.equal(form.state().connection.error.message, 'Cannot reach the gateway.');
});

test('a refused form token keeps the usual message; another terminal refusal of a link keeps its token', async t => {
  const form = setup(t, memoryStorage());
  form.host.refuse = new AuthenticationError();
  form.controller.connect({ url: 'http://127.0.0.1:7434', token: TOKEN });
  await until(() => form.state().connection.phase === 'failed', 'failed');
  assert.match(form.state().connection.error.message, /refused this access token/);

  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const w = setup(t, storage);
  w.host.refuse = new ConfigurationError('The gateway does not allow this page\'s origin.');
  w.controller.connect({ url: 'http://127.0.0.1:7433', token: TOKEN, link: true });
  await until(() => w.state().connection.phase === 'failed', 'failed');
  assert.match(w.state().connection.error.message, /origin/);
  assert.equal(storage.items.get(LINK_TOKEN_KEY), TOKEN, 'not a verdict on the token: a reload tries again');
});

test('Disconnect and a form connection forget the link token; leaving the page (reload) keeps it', async t => {
  const storage = memoryStorage({ [LINK_TOKEN_KEY]: TOKEN });
  const w = setup(t, storage);
  w.controller.connect({ url: 'http://127.0.0.1:7433', token: TOKEN, link: true });
  await until(() => w.state().connection.phase === 'open', 'open');
  assert.equal(storage.items.get(LINK_TOKEN_KEY), TOKEN, 'connecting with the link keeps it');
  w.controller.disconnect({ keepTerminals: true, keepLink: true });
  assert.equal(storage.items.get(LINK_TOKEN_KEY), TOKEN, 'pagehide keeps it for the reload');
  w.controller.disconnect();
  assert.equal(storage.items.has(LINK_TOKEN_KEY), false, 'Disconnect forgets it');

  storage.items.set(LINK_TOKEN_KEY, TOKEN);
  w.controller.connect({ url: 'http://127.0.0.1:7434', token: OTHER });
  assert.equal(storage.items.has(LINK_TOKEN_KEY), false, 'a token typed in the form replaces the link');
  await until(() => w.state().connection.phase === 'open', 'open');
  assert.equal(w.state().connection.link, undefined);
  assert.equal(w.tokens.at(-1), OTHER);
});

test('showError shows the connect form with a message', t => {
  const w = setup(t, memoryStorage());
  w.controller.showError(LINK_NOT_LOOPBACK);
  assert.equal(w.state().connection.phase, 'failed');
  assert.equal(w.state().connection.error.message, LINK_NOT_LOOPBACK);
});
