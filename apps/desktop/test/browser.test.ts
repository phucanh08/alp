import { describe, expect, test } from 'bun:test';
import {
  BLOCKED_EVENT, BROWSER_PARTITION, DESKTOP_MARKER, MAX_BLOCKED_URL, OPEN_EVENT, blockedEventScript, OpenRequests, isAllowedGuestNavigation, isAllowedGuestRequest, isBrowsableUrl,
  dashboardPort, isDashboardUrl, localHosts, markUserAgent, openEventScript, prepareWebview,
} from '../src/browser';

const hosts = localHosts('Anh-MacBook.local', { en0: [{ address: '192.168.1.20', family: 'IPv4' } as never, { address: 'fe80::1%en0', family: 'IPv6' } as never] });
const dashboard = { ports: new Set([7433]), hosts };

describe('localHosts', () => {
  test('names the machine in its plain and .local forms, its addresses and the loopback spellings', () => {
    for (const host of ['localhost', '0.0.0.0', '[::]', '[::1]', '[::ffff:7f00:1]', 'anh-macbook', 'anh-macbook.local', '192.168.1.20', '[fe80::1]']) expect(hosts.has(host)).toBe(true);
  });
});

describe('isDashboardUrl', () => {
  test.each([
    'http://127.0.0.1:7433/', 'http://127.0.0.2:7433/x', 'http://localhost:7433/', 'http://LOCALHOST:7433/', 'http://app.localhost:7433/',
    'http://[::1]:7433/', 'http://[::ffff:127.0.0.1]:7433/', 'http://0.0.0.0:7433/', 'http://[::]:7433/', 'http://2130706433:7433/',
    'http://0x7f.1:7433/', 'http://0177.0.0.1:7433/', 'http://anh-macbook:7433/', 'http://Anh-MacBook.local:7433/', 'http://anh-macbook.local.:7433/',
    'http://192.168.1.20:7433/', 'ws://127.0.0.1:7433/v1/socket', 'https://localhost:7433/', 'http://user:pw@127.0.0.1:7433/',
  ])('is the dashboard: %s', target => expect(isDashboardUrl(target, dashboard)).toBe(true));
  test.each([
    'http://127.0.0.1:3000/', 'http://localhost:7434/', 'https://example.com:7433/', 'http://127.example.com:7433/', 'about:blank', 'not a url',
  ])('is not: %s', target => expect(isDashboardUrl(target, dashboard)).toBe(false));
  test('follows the ports the dashboard has had', () => {
    const ports = new Set([7433]);
    const target = { ports, hosts };
    expect(isDashboardUrl('http://127.0.0.1:9000/', target)).toBe(false);
    ports.add(9000);
    expect(isDashboardUrl('http://127.0.0.1:9000/', target)).toBe(true);
  });
  test('default ports count', () => {
    expect(isDashboardUrl('http://localhost/', { ports: new Set([80]), hosts })).toBe(true);
  });
  test.each([
    'http://[::ffff:127.0.0.5]:7433/', 'http://[::ffff:7f00:1]:7433/', 'http://[::ffff:7f01:203]:7433/', 'http://[0:0:0:0:0:ffff:127.1.2.3]:7433/',
    'http://[::ffff:7fff:ffff]:7433/', 'http://[::127.0.0.1]:7433/', 'http://[::7f00:1]:7433/', 'http://[::ffff:0:0]:7433/',
    'http://[::ffff:192.168.1.20]:7433/', 'http://[::ffff:c0a8:114]:7433/',
  ])('an IPv4-mapped or -compatible loopback or local address is the dashboard: %s', target => expect(isDashboardUrl(target, dashboard)).toBe(true));
  test.each(['http://[::ffff:8.8.8.8]:7433/', 'http://[::ffff:7f00:1]:7434/', 'http://[2001:db8::7f00:1]:7433/'])('a mapped address elsewhere is not: %s', target => {
    expect(isDashboardUrl(target, dashboard)).toBe(false);
  });
});

describe('dashboardPort', () => {
  test('the explicit port, else the scheme default; never 0', () => {
    expect(dashboardPort('http://127.0.0.1:7433')).toBe(7433);
    expect(dashboardPort('http://127.0.0.1')).toBe(80);
    expect(dashboardPort('https://localhost')).toBe(443);
    expect(dashboardPort('http://127.0.0.1:80')).toBe(80);
    for (const origin of ['', 'garbage', 'file:///x', 'alp-page://app']) expect(dashboardPort(origin)).toBeUndefined();
  });
});

describe('guest navigation', () => {
  test.each(['http://127.0.0.1:3000/', 'https://example.com/a?b#c', 'about:blank', 'http://localhost:5173/'])('allows %s', target => {
    expect(isAllowedGuestNavigation(target, true, dashboard)).toBe(true);
    expect(isAllowedGuestNavigation(target, false, dashboard)).toBe(true);
  });
  test.each([
    'file:///etc/passwd', 'data:text/html,<p>x', 'javascript:alert(1)', 'chrome://settings', 'devtools://devtools/bundled/x.html',
    'blob:https://example.com/0a', 'alp-page://app/error.html', 'ftp://example.com/', 'about:srcdoc',
    'http://127.0.0.1:7433/', 'http://localhost:7433/#token=x', 'http://[::1]:7433/', 'http://anh-macbook.local:7433/',
  ])('refuses %s as a page', target => expect(isAllowedGuestNavigation(target, true, dashboard)).toBe(false));
  test('a subframe may hold an inline (srcdoc) document, nothing else beyond pages', () => {
    expect(isAllowedGuestNavigation('about:srcdoc', false, dashboard)).toBe(true);
    expect(isAllowedGuestNavigation('file:///etc/hosts', false, dashboard)).toBe(false);
    expect(isAllowedGuestNavigation('http://localhost:7433/', false, dashboard)).toBe(false);
  });
});

describe('guest requests', () => {
  test.each(['https://example.com/a.js', 'http://127.0.0.1:3000/api', 'data:image/png;base64,AA', 'blob:https://example.com/1', 'wss://example.com/s'])('allows %s', target => {
    expect(isAllowedGuestRequest(target, dashboard)).toBe(true);
  });
  test.each(['http://127.0.0.1:7433/v1/tickets', 'ws://localhost:7433/v1/socket', 'http://[::1]:7433/', 'file:///etc/passwd', 'chrome://gpu', 'devtools://x', 'garbage'])('refuses %s', target => {
    expect(isAllowedGuestRequest(target, dashboard)).toBe(false);
  });
});

describe('isBrowsableUrl', () => {
  test('http, https and about:blank only', () => {
    expect(isBrowsableUrl('https://a.example/')).toBe(true);
    expect(isBrowsableUrl('about:blank')).toBe(true);
    for (const target of ['about:blank#x', 'about:config', 'http://', 'file:///', undefined, '']) expect(isBrowsableUrl(target)).toBe(false);
  });
});

describe('prepareWebview', () => {
  test('forces the partition and safe preferences, and drops any preload', () => {
    const prefs: Record<string, unknown> = { preload: 'file:///tmp/evil.js', preloadURL: 'file:///tmp/evil.js', nodeIntegration: true, sandbox: false, contextIsolation: false, webSecurity: false, devTools: true, nodeIntegrationInSubFrames: true };
    const params: Record<string, unknown> = { src: 'https://example.com/', partition: BROWSER_PARTITION, preload: 'file:///tmp/evil.js' };
    expect(prepareWebview(prefs, params)).toBe(true);
    expect(prefs.preload).toBeUndefined();
    expect(prefs.preloadURL).toBeUndefined();
    expect(params.preload).toBeUndefined();
    expect(prefs).toMatchObject({ partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, devTools: false, webviewTag: false });
  });
  test.each([
    [{ src: 'https://example.com/' }],
    [{ src: 'https://example.com/', partition: '' }],
    [{ src: 'https://example.com/', partition: 'persist:other' }],
    [{ src: 'https://example.com/', partition: 'alp-browser' }],
    [{ src: 'file:///etc/passwd', partition: BROWSER_PARTITION }],
    [{ src: 'data:text/html,x', partition: BROWSER_PARTITION }],
    [{ src: 'http://127.0.0.1:7433/x', partition: 'persist:other' }],
  ])('refuses %o', params => expect(prepareWebview({}, params as never)).toBe(false));
  test('keeps only allowlisted preferences: a hostile page sets nothing else', () => {
    const prefs: Record<string, unknown> = {
      enableBlinkFeatures: 'FileSystemAccess', disableBlinkFeatures: 'X', additionalArguments: ['--remote-debugging-port=1'], javascript: false,
      nativeWindowOpen: true, safeDialogs: false, experimentalFeatures: true, allowRunningInsecureContent: true, webviewTag: true, plugins: true,
      enableWebSQL: true, nodeIntegrationInWorker: true, disablePopups: true, partition: 'persist:other', session: {}, zoomFactor: 1.5,
      v8CacheOptions: 'none', backgroundThrottling: false, offscreen: true, spellcheck: true, scrollBounce: true, unknownFutureKey: 'x',
    };
    const params: Record<string, unknown> = {
      src: 'https://example.com/', partition: BROWSER_PARTITION, allowpopups: 'true', webpreferences: 'nodeIntegration=yes,contextIsolation=no',
      disablewebsecurity: 'true', nodeintegration: 'true', nodeintegrationinsubframes: 'true', preload: 'file:///tmp/evil.js', plugins: 'true',
      blinkfeatures: 'X', enableblinkfeatures: 'X', disableblinkfeatures: 'Y',
    };
    expect(prepareWebview(prefs, params)).toBe(true);
    expect(prefs).toEqual({
      partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, plugins: false,
      experimentalFeatures: false, enableWebSQL: false, javascript: true, safeDialogs: true, disablePopups: false, zoomFactor: 1.5,
    });
    expect(params).toEqual({ src: 'https://example.com/', partition: BROWSER_PARTITION, allowpopups: 'true' });
  });
  test.each([0, -1, Number.NaN, Infinity, '2', null])('drops a zoomFactor that is not a positive number: %p', zoomFactor => {
    const prefs: Record<string, unknown> = { zoomFactor };
    expect(prepareWebview(prefs, { partition: BROWSER_PARTITION })).toBe(true);
    expect('zoomFactor' in prefs).toBe(false);
  });
  test('accepts about:blank and no src', () => {
    expect(prepareWebview({}, { src: 'about:blank', partition: BROWSER_PARTITION })).toBe(true);
    expect(prepareWebview({}, { partition: BROWSER_PARTITION })).toBe(true);
  });
});

describe('OpenRequests', () => {
  test('at most `limit` per guest in a window, then again once it passed', () => {
    let now = 0;
    const requests = new OpenRequests(3, 1000, () => now);
    expect([1, 2, 3, 4].map(() => requests.take(7))).toEqual([true, true, true, false]);
    expect(requests.take(8)).toBe(true);
    now = 1001;
    expect(requests.take(7)).toBe(true);
  });
});

describe('openEventScript', () => {
  test('carries the url as data', () => {
    const script = openEventScript(12, 'https://x.example/"});alert(1);// ');
    expect(script).toContain(JSON.stringify(OPEN_EVENT));
    const detail = new Function('window', 'CustomEvent', `let got; window = { dispatchEvent: e => { got = e; } }; ${script.replace('window.dispatchEvent', 'window.dispatchEvent')}; return got;`);
    const got = detail(undefined, class { type: string; detail: unknown; constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; } });
    expect(got.detail).toEqual({ guest: 12, url: 'https://x.example/"});alert(1);// ' });
  });
});

describe('blockedEventScript', () => {
  const run = (script: string) => new Function('window', 'CustomEvent', `let got; window = { dispatchEvent: e => { got = e; } }; ${script}; return got;`)(undefined, class { type: string; detail: unknown; constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; } });
  test('carries the guest and the address as data', () => {
    const url = 'file:///etc/hosts"});alert(1);//\u2028</script>';
    const got = run(blockedEventScript(9, url));
    expect(got.type).toBe(BLOCKED_EVENT);
    expect(got.detail).toEqual({ guest: 9, url });
  });
  test('cuts a long address', () => {
    const got = run(blockedEventScript(3, `https://x.example/${'a'.repeat(5_000)}`));
    expect(got.detail.url.length).toBe(MAX_BLOCKED_URL);
  });
});

describe('markUserAgent', () => {
  test('adds the marker once', () => {
    const once = markUserAgent('Mozilla/5.0 Chrome/140');
    expect(once.endsWith(` ${DESKTOP_MARKER}`)).toBe(true);
    expect(markUserAgent(once)).toBe(once);
  });
});
