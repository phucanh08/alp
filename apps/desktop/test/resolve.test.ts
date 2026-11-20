import { describe, expect, test } from 'bun:test';
import { binDirectories, parseShellProbe, resolveAlp, type LoginShell } from '../src/resolve';

const HOME = '/Users/u';
function deps(files: string[], shell?: { alp?: string; path?: string }, extra: { override?: string; envPath?: string } = {}) {
  const calls = { shell: 0 };
  const loginShell: LoginShell = async () => { calls.shell += 1; return shell; };
  return { calls, deps: { home: HOME, envPath: extra.envPath ?? '/usr/bin:/bin', override: extra.override, isExecutable: async (f: string) => files.includes(f), loginShell } };
}

describe('resolveAlp', () => {
  test('fixed directories come in alp-client order', () => {
    expect(binDirectories(HOME)).toEqual(['/Users/u/.alp/bin', '/Users/u/.npm-global/bin', '/Users/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  });
  test('the first fixed directory that has alp wins, before the login shell', async () => {
    const { deps: d, calls } = deps(['/Users/u/.npm-global/bin/alp', '/usr/local/bin/alp', '/usr/local/bin/node'], { alp: '/elsewhere/alp' });
    const result = await resolveAlp(d);
    expect(result).toMatchObject({ alp: '/Users/u/.npm-global/bin/alp' });
    expect(calls.shell).toBe(0);
    if ('path' in result) expect(result.path.split(':').slice(0, 2)).toEqual(['/Users/u/.npm-global/bin', '/Users/u/.alp/bin']);
  });
  test('the login shell is asked when no fixed directory has alp', async () => {
    const { deps: d } = deps(['/Users/u/.nvm/versions/node/v24/bin/alp', '/Users/u/.nvm/versions/node/v24/bin/node'], { alp: '/Users/u/.nvm/versions/node/v24/bin/alp', path: '/Users/u/.nvm/versions/node/v24/bin:/usr/bin' });
    expect(await resolveAlp(d)).toMatchObject({ alp: '/Users/u/.nvm/versions/node/v24/bin/alp' });
  });
  test('node missing from the fixed PATH: the login shell PATH is appended', async () => {
    const { deps: d, calls } = deps(['/Users/u/.npm-global/bin/alp', '/opt/n/bin/node'], { path: '/opt/n/bin:/usr/bin' });
    const result = await resolveAlp(d);
    expect(calls.shell).toBe(1);
    if (!('path' in result)) throw new Error('expected a path');
    expect(result.path.split(':')).toContain('/opt/n/bin');
    expect(result.path.split(':').indexOf('/opt/n/bin')).toBeGreaterThan(result.path.split(':').indexOf('/usr/bin'));
  });
  test('an explicit override wins over the fixed directories', async () => {
    const { deps: d } = deps(['/custom/alp', '/usr/local/bin/alp', '/usr/local/bin/node'], undefined, { override: '/custom/alp' });
    expect(await resolveAlp(d)).toMatchObject({ alp: '/custom/alp' });
  });
  test('a broken override is reported, never replaced by another alp', async () => {
    const { deps: d } = deps(['/usr/local/bin/alp'], undefined, { override: '/custom/alp' });
    expect(await resolveAlp(d)).toEqual({ missing: true, override: '/custom/alp' });
    const { deps: relative } = deps(['alp', '/usr/local/bin/alp'], undefined, { override: 'alp' });
    expect(await resolveAlp(relative)).toEqual({ missing: true, override: 'alp' });
  });
  test('missing everywhere, or a login shell that fails or names a relative path', async () => {
    expect(await resolveAlp(deps([], undefined).deps)).toEqual({ missing: true });
    expect(await resolveAlp(deps(['alp'], { alp: 'alp' }).deps)).toEqual({ missing: true });
    const failing = deps([]).deps;
    failing.loginShell = async () => { throw new Error('timeout'); };
    expect(await resolveAlp(failing)).toEqual({ missing: true });
  });
  test('the login shell is asked at most once', async () => {
    const { deps: d, calls } = deps([], { path: '/x' });
    await resolveAlp(d);
    expect(calls.shell).toBe(1);
  });
});

describe('parseShellProbe', () => {
  test('reads after the marker, ignoring rc noise', () => {
    expect(parseShellProbe('welcome!\n__ALP_DESKTOP__\n/opt/bin/alp\n/opt/bin:/usr/bin\n')).toEqual({ alp: '/opt/bin/alp', path: '/opt/bin:/usr/bin' });
    expect(parseShellProbe('__ALP_DESKTOP__\n\n/usr/bin\n')).toEqual({ alp: undefined, path: '/usr/bin' });
    expect(parseShellProbe('no marker')).toEqual({});
  });
});
