import { describe, expect, test } from 'bun:test';
import { isAllowedExternal, isAllowedNavigation, isAllowedPermission, isTicketRequest, navigationGuard } from '../src/policy';

const ORIGIN = 'http://127.0.0.1:7433';

describe('isAllowedNavigation', () => {
  test('allows the exact origin, any path', () => {
    expect(isAllowedNavigation('http://127.0.0.1:7433/', ORIGIN)).toBe(true);
    expect(isAllowedNavigation('http://127.0.0.1:7433/sessions/x?y=1#z', ORIGIN)).toBe(true);
  });
  test.each([
    'http://127.0.0.1:7434/', 'http://localhost:7433/', 'https://127.0.0.1:7433/', 'http://example.com/',
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url',
  ])('refuses %s', target => expect(isAllowedNavigation(target, ORIGIN)).toBe(false));
  test('refuses everything while no origin is shown', () => {
    expect(isAllowedNavigation('http://127.0.0.1:7433/', undefined)).toBe(false);
  });
});

describe('isAllowedExternal', () => {
  test('https only', () => {
    expect(isAllowedExternal('https://github.com/x')).toBe(true);
    for (const url of ['http://example.com', 'file:///Applications', 'mailto:a@b.c', 'javascript:1', 'smb://h/s', 'https://u:p@x.test', 'nope']) {
      expect(isAllowedExternal(url)).toBe(false);
    }
  });
});

describe('isAllowedPermission', () => {
  test('clipboard writes from the shown origin only', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isAllowedPermission('clipboard-sanitized-write', 'http://127.0.0.1:9999/', ORIGIN)).toBe(false);
    expect(isAllowedPermission('clipboard-sanitized-write', undefined, ORIGIN)).toBe(false);
    expect(isAllowedPermission('clipboard-sanitized-write', `${ORIGIN}/`, undefined)).toBe(false);
  });
  test.each(['media', 'notifications', 'geolocation', 'clipboard-read', 'openExternal', 'fileSystem'])('denies %s', permission => {
    expect(isAllowedPermission(permission, `${ORIGIN}/`, ORIGIN)).toBe(false);
  });
});

describe('navigationGuard', () => {
  const event = (url: string, isMainFrame: boolean) => {
    const e = { url, isMainFrame, prevented: false, preventDefault() { e.prevented = true; } };
    return e;
  };
  test('a subframe is held to the same origin as the main frame', () => {
    const guard = navigationGuard(() => ORIGIN);
    for (const isMainFrame of [true, false]) {
      const away = event('https://evil.test/', isMainFrame);
      guard(away);
      expect(away.prevented).toBe(true);
      const home = event(`${ORIGIN}/sessions`, isMainFrame);
      guard(home);
      expect(home.prevented).toBe(false);
    }
  });
  test('reads the origin at each event, and refuses all while none is shown', () => {
    let origin: string | undefined;
    const guard = navigationGuard(() => origin);
    const first = event(`${ORIGIN}/`, false);
    guard(first);
    expect(first.prevented).toBe(true);
    origin = ORIGIN;
    const second = event(`${ORIGIN}/`, false);
    guard(second);
    expect(second.prevented).toBe(false);
  });
});

describe('about:blank and about:srcdoc subframes (decision: refused)', () => {
  // apps/web has no iframes. A blank or srcdoc frame would run with the page's origin outside the
  // origin check (its URL's origin is "null"), so the guard refuses it like any other target; a
  // future iframe in apps/web must load a real URL on alp web's origin.
  test.each(['about:blank', 'about:srcdoc', 'about:blank#x', 'about:blank?x'])('refuses %s in a subframe and the main frame', target => {
    const guard = navigationGuard(() => ORIGIN);
    for (const isMainFrame of [true, false]) {
      const e = { url: target, isMainFrame, prevented: false, preventDefault() { e.prevented = true; } };
      guard(e);
      expect(e.prevented).toBe(true);
    }
    expect(isAllowedNavigation(target, ORIGIN)).toBe(false);
  });
});

describe('isTicketRequest', () => {
  test('POST /v1/tickets on the shown origin only', () => {
    expect(isTicketRequest(`${ORIGIN}/v1/tickets`, ORIGIN)).toBe(true);
    expect(isTicketRequest(`${ORIGIN}/v1/tickets?x=1`, ORIGIN)).toBe(true);
    for (const url of [`${ORIGIN}/v1/tickets/x`, `${ORIGIN}/v1/ws`, 'http://127.0.0.1:7434/v1/tickets', `${ORIGIN}/readyz`, 'nope']) {
      expect(isTicketRequest(url, ORIGIN)).toBe(false);
    }
    expect(isTicketRequest(`${ORIGIN}/v1/tickets`, undefined)).toBe(false);
  });
});
