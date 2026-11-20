import { describe, expect, test } from 'bun:test';
import { isAllowedExternal, isAllowedNavigation, isAllowedPermission } from '../src/policy';

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
