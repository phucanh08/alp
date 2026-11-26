// ALP.app's Browser tab (t-9116): typed addresses as Paseo's normalizeBrowserUrl reads them, what a
// tab may show, the desktop marker, and the Browser tabs kept in the workspace layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_MARKER, MAX_BROWSERS, browserLabel, isBrowsableUrl, isDesktopApp, nextBrowserId, parseBrowsers, readAddress } from '../dist-lib/browser-url.js';
import { parseLayout, serializeLayout } from '../dist-lib/layout.js';
import type { Layout } from '../dist-lib/layout.js';

test('browser: addresses read as Paseo reads them', () => {
  const cases = [
    ['example.com', 'https://example.com/'],
    ['  example.com/a?b#c ', 'https://example.com/a?b#c'],
    ['example.com:8080/x', 'https://example.com:8080/x'],
    ['localhost', 'http://localhost/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost:3000/app', 'http://localhost:3000/app'],
    ['127.0.0.1:5173', 'http://127.0.0.1:5173/'],
    ['10.0.0.2', 'http://10.0.0.2/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['http://example.com', 'http://example.com/'],
    ['https://Example.COM/A', 'https://example.com/A'],
    ['//example.com/x', 'https://example.com/x'],
    ['about:blank', 'about:blank'],
    ['words', 'https://words/'],
  ];
  for (const [text, url] of cases) assert.deepEqual(readAddress(text), { url }, text);
});

test('browser: no search, no other schemes', () => {
  for (const text of ['', '   ', 'two words', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'about:config', 'ftp://example.com', 'http://']) {
    assert.ok('error' in readAddress(text), text);
  }
  assert.match((readAddress('file:///etc/passwd') as { error: string }).error, /only http and https/);
  assert.match((readAddress('two words') as { error: string }).error, /no search/);
});

test('browser: what a tab may show', () => {
  for (const url of ['https://example.com/', 'http://localhost:3000/', 'about:blank']) assert.equal(isBrowsableUrl(url), true, url);
  for (const url of ['file:///x', 'about:srcdoc', 'blob:https://a/1', `https://a.example/${'x'.repeat(3000)}`, 42, null]) assert.equal(isBrowsableUrl(url), false, String(url).slice(0, 30));
});

test('browser: the desktop marker decides whether Browser is offered', () => {
  assert.equal(isDesktopApp(`Mozilla/5.0 (Macintosh) Chrome/140 Electron/44 ${DESKTOP_MARKER}`), true);
  assert.equal(isDesktopApp('Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36'), false);
  assert.equal(isDesktopApp('Mozilla/5.0 Electron/44'), false);
  assert.equal(isDesktopApp(undefined), false);
});

test('browser: labels and ids', () => {
  assert.equal(browserLabel('http://localhost:3000/a'), 'localhost:3000');
  assert.equal(browserLabel('about:blank'), 'Browser');
  assert.equal(browserLabel(undefined), 'Browser');
  assert.equal(nextBrowserId([]), 'b1');
  assert.equal(nextBrowserId(['b1', 'b3']), 'b2');
});

test('browser: saved tabs are checked and capped', () => {
  const many = Array.from({ length: MAX_BROWSERS + 5 }, (_, index) => ({ id: `b${index + 1}`, url: 'https://example.com/' }));
  assert.equal(parseBrowsers(many).length, MAX_BROWSERS);
  assert.deepEqual(parseBrowsers([
    { id: 'b1', url: 'http://localhost:3000/' },
    { id: 'b1', url: 'https://dup.example/' },
    { id: 'b2', url: 'file:///etc/passwd' },
    { id: 'x', url: 'https://example.com/' },
    { id: 'b3', url: 'javascript:alert(1)' },
    { id: 'b4', url: 'about:blank', extra: 'dropped' },
    'b5', null,
  ]), [{ id: 'b1', url: 'http://localhost:3000/' }, { id: 'b4', url: 'about:blank' }]);
  assert.deepEqual(parseBrowsers('nope'), []);
});

test('browser: saved tabs never hold the dashboard itself, nor any #fragment', () => {
  const own = 'http://127.0.0.1:7433';
  assert.deepEqual(parseBrowsers([
    { id: 'b1', url: 'http://127.0.0.1:7433/#token=secret' },
    { id: 'b2', url: 'http://127.0.0.1:7433/v1/tickets' },
    { id: 'b3', url: 'http://127.0.0.1:3000/app#/route?x=1' },
    { id: 'b4', url: 'https://example.com/a?b=1#c' },
    { id: 'b5', url: 'http://localhost:7433/' },
    { id: 'b6', url: 'about:blank' },
  ], own), [
    { id: 'b3', url: 'http://127.0.0.1:3000/app' },
    { id: 'b4', url: 'https://example.com/a?b=1' },
    { id: 'b5', url: 'http://localhost:7433/' },
    { id: 'b6', url: 'about:blank' },
  ]);
  // Without an origin of its own (no location, as in node), only the fragment goes.
  assert.deepEqual(parseBrowsers([{ id: 'b1', url: 'http://127.0.0.1:7433/#token=secret' }]), [{ id: 'b1', url: 'http://127.0.0.1:7433/' }]);
});

test('browser: saving drops the dashboard tab and fragments too', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:7433' }, configurable: true });
  try {
    const layout = { workspaces: { w: { tasks: [], panels: [], order: [], browsers: [{ id: 'b1', url: 'http://127.0.0.1:7433/#token=secret' }, { id: 'b2', url: 'https://example.com/#x' }], at: 1 } } };
    const saved = serializeLayout(layout as unknown as Layout);
    assert.ok(!saved.includes('secret') && !saved.includes('7433') && !saved.includes('#'), saved);
    assert.deepEqual(JSON.parse(saved).workspaces.w.browsers, [{ id: 'b2', url: 'https://example.com/' }]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test('browser: layout keeps Browser tabs with their addresses, and nothing else', () => {
  const raw = JSON.stringify({ v: 1, workspaces: { w: { tasks: [], panels: [], order: ['browser:b1'], active: 'browser:b1', browsers: [{ id: 'b1', url: 'http://localhost:3000/', title: 'x' }, { id: 'b2', url: 'file:///etc/passwd' }], at: 1 } } });
  const layout = parseLayout(raw);
  assert.deepEqual(layout.workspaces.w.browsers, [{ id: 'b1', url: 'http://localhost:3000/' }]);
  assert.equal(layout.workspaces.w.active, 'browser:b1');
  const saved = serializeLayout(layout);
  assert.ok(!saved.includes('file:') && !saved.includes('title'));
  assert.equal(parseLayout(JSON.stringify({ v: 1, workspaces: { w: { tasks: [], panels: [], order: [], at: 1 } } })).workspaces.w.browsers, undefined);
});
