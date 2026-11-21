import { describe, expect, test } from 'bun:test';
import {
  compareVersions, confirmAction, confirmQuery, installArgs, installEnv, installFailure, installPlan, installSource,
  latestRelease, MIN_VERSION, MIRROR_VARIABLE, pickRelease, RELEASES,
} from '../src/install';

const SHA = 'a'.repeat(64);
const sums = (...names: string[]) => names.map(name => `${SHA}  ${name}`).join('\n') + '\n';

describe('installSource (t-81b0.8)', () => {
  test('GitHub Releases by default', () => {
    const source = installSource(true, {});
    expect(source.latest).toBe(`${RELEASES}/latest/download`);
    expect(source.forVersion('0.0.1-beta.9')).toBe('https://github.com/phucanh08/alp/releases/download/v0.0.1-beta.9');
    expect(source.mirror).toBe(false);
  });
  test('a packaged app ignores the test mirror, whatever it names', () => {
    for (const value of ['/tmp/mirror', 'file:///tmp/mirror', 'https://evil.example/']) {
      const source = installSource(true, { [MIRROR_VARIABLE]: value });
      expect(source.mirror).toBe(false);
      expect(source.latest).toBe(`${RELEASES}/latest/download`);
      expect(source.forVersion('1.0.0')).toStartWith('https://github.com/phucanh08/alp/');
    }
  });
  test('an unpackaged app takes an absolute directory or a file:// URL, nothing else', () => {
    expect(installSource(false, { [MIRROR_VARIABLE]: '/tmp/m/' })).toMatchObject({ latest: 'file:///tmp/m', mirror: true });
    expect(installSource(false, { [MIRROR_VARIABLE]: 'file:///tmp/m/' }).forVersion('1.0.0')).toBe('file:///tmp/m');
    expect(installSource(false, { [MIRROR_VARIABLE]: 'relative/m' }).mirror).toBe(false);
    expect(installSource(false, { [MIRROR_VARIABLE]: 'https://evil.example/' }).mirror).toBe(false);
  });
});

describe('pickRelease', () => {
  test('the one macOS archive for the architecture, as install.sh picks it', () => {
    const text = sums('alp-0.0.1-beta.9-darwin-arm64.tar.gz', 'alp-0.0.1-beta.9-darwin-x64.tar.gz', 'alp-0.0.1-beta.9-linux-arm64.tar.gz', 'install.sh');
    expect(pickRelease(text, 'arm64')).toEqual({ version: '0.0.1-beta.9', asset: 'alp-0.0.1-beta.9-darwin-arm64.tar.gz', sha256: SHA });
    expect(pickRelease(text, 'x64')).toMatchObject({ asset: 'alp-0.0.1-beta.9-darwin-x64.tar.gz' });
    expect(pickRelease(`${SHA} *alp-1.0.0-darwin-arm64.tar.gz`, 'arm64')).toMatchObject({ version: '1.0.0' });
  });
  test('refuses none, two, a malformed checksum and odd names', () => {
    expect(pickRelease(sums('alp-1.0.0-linux-arm64.tar.gz'), 'arm64')).toHaveProperty('error');
    expect(pickRelease(sums('alp-1.0.0-darwin-arm64.tar.gz', 'alp-1.1.0-darwin-arm64.tar.gz'), 'arm64')).toHaveProperty('error');
    expect(pickRelease(`xyz  alp-1.0.0-darwin-arm64.tar.gz`, 'arm64')).toHaveProperty('error');
    expect(pickRelease(sums('alp-1.0.0;rm-darwin-arm64.tar.gz'), 'arm64')).toHaveProperty('error');
    expect(pickRelease(sums('alp-1.x-darwin-arm64.tar.gz'), 'arm64')).toHaveProperty('error');
  });
});

describe('compareVersions', () => {
  test('semantic version order, prereleases before the release', () => {
    expect(compareVersions('0.0.1-beta.9', MIN_VERSION)).toBe(0);
    expect(compareVersions('0.0.1-beta.8', MIN_VERSION)).toBe(-1);
    expect(compareVersions('0.0.1-beta.10', MIN_VERSION)).toBe(1);
    expect(compareVersions('0.0.1', MIN_VERSION)).toBe(1);
    expect(compareVersions('0.0.1-alpha.20', MIN_VERSION)).toBe(-1);
    expect(compareVersions('0.1.0-beta.1', MIN_VERSION)).toBe(1);
    expect(compareVersions('0.0.1-beta', '0.0.1-beta.1')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });
});

describe('latestRelease', () => {
  const source = installSource(true, {});
  test('reads SHA256SUMS of the latest release', async () => {
    const asked: string[] = [];
    const release = await latestRelease(source, 'arm64', async url => { asked.push(url); return sums('alp-0.0.1-beta.9-darwin-arm64.tar.gz'); });
    expect(release).toMatchObject({ version: '0.0.1-beta.9' });
    expect(asked).toEqual(['https://github.com/phucanh08/alp/releases/latest/download/SHA256SUMS']);
  });
  test('an older release than the app needs, a failed read and another architecture are refused', async () => {
    expect(await latestRelease(source, 'arm64', async () => sums('alp-0.0.1-beta.8-darwin-arm64.tar.gz'))).toEqual({ error: `The latest ALP release is 0.0.1-beta.8; this app needs ${MIN_VERSION} or later.` });
    expect((await latestRelease(source, 'arm64', async () => { throw new Error('HTTP 404'); })) as { error: string }).toMatchObject({ error: expect.stringContaining('HTTP 404') });
    expect(await latestRelease(source, 'ia32', async () => '')).toHaveProperty('error');
  });
});

describe('the plan and install.sh', () => {
  const release = { version: '0.0.1-beta.9', asset: 'alp-0.0.1-beta.9-darwin-arm64.tar.gz', sha256: SHA };
  const plan = installPlan(release, installSource(true, {}), '/Users/u', {});
  test('names every path, under <home>/.alp', () => {
    expect(plan).toMatchObject({
      source: 'https://github.com/phucanh08/alp/releases/download/v0.0.1-beta.9',
      root: '/Users/u/.alp', appDir: '/Users/u/.alp/app/0.0.1-beta.9', command: '/Users/u/.alp/bin/alp', alpHome: '/Users/u/.alp',
    });
    expect(plan.createsHome).toBe(true);
    expect(installPlan(release, installSource(true, {}), '/Users/u', { ALP_HOME: '/data/alp' })).toMatchObject({ alpHome: '/data/alp', createsHome: false });
    expect(confirmQuery(plan, 'n').homeNote).toContain('0700');
    expect(confirmQuery(installPlan(release, installSource(true, {}), '/Users/u', { ALP_HOME: '/data/alp' }), 'n').homeNote).toContain('not created'); 
  });
  test('install.sh gets this version from this release, explicit paths, and no profile edit', () => {
    expect(installArgs(plan)).toEqual(['--version', '0.0.1-beta.9', '--base-url', plan.source, '--root', '/Users/u/.alp', '--dir', '/Users/u/.alp/bin', '--no-modify-path']);
  });
  test("install.sh's environment cannot change the source", () => {
    const env = installEnv({ PATH: '/x', HOME: '/Users/u', ALP_INSTALL_BASE_URL: 'https://evil', ALP_INSTALL_REPO: 'evil/alp', ELECTRON_RUN_AS_NODE: '1', [MIRROR_VARIABLE]: '/m' });
    expect(env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/x', HOME: '/Users/u' });
  });
  test("a failure is install.sh's own reason", () => {
    expect(installFailure({ code: 1, stdout: 'alp-install: downloading', stderr: 'alp-install: error: checksum mismatch for x (expected a, got b)\n', timedOut: false })).toBe('checksum mismatch for x (expected a, got b)');
    expect(installFailure({ code: 1, stdout: '', stderr: 'sh: boom\n', timedOut: false })).toBe('sh: boom');
    expect(installFailure({ code: null, stdout: '', stderr: '', timedOut: true })).toContain('did not finish');
  });
  test('the page states the plan and carries the nonce; only its own answers are read', () => {
    expect(confirmQuery(plan, 'n1')).toMatchObject({ version: '0.0.1-beta.9', appDir: plan.appDir, command: plan.command, alpHome: plan.alpHome, bin: '/Users/u/.alp/bin', nonce: 'n1' });
    expect(confirmAction('alp-page://app/confirm?action=install&nonce=n1')).toEqual({ action: 'install', nonce: 'n1' });
    expect(confirmAction('alp-page://app/confirm?action=cancel&nonce=n1')).toEqual({ action: 'cancel', nonce: 'n1' });
    for (const url of ['alp-page://app/confirm?action=install', 'alp-page://app/confirm?action=run&nonce=n1', 'alp-page://app/install.html?action=install&nonce=n1',
      'http://127.0.0.1:1/confirm?action=install&nonce=n1', 'alp-page://other/confirm?action=install&nonce=n1', 'nope']) expect(confirmAction(url)).toBeUndefined();
  });
});
