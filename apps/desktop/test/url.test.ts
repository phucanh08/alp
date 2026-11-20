import { describe, expect, test } from 'bun:test';
import { parseDashboardOutput, validateDashboardUrl } from '../src/url';

const TOKEN = `alpgw1.${'0123456789abcdef'}.${'A'.repeat(42)}_`;
const GOOD = `http://127.0.0.1:7433/#token=${TOKEN}`;

describe('validateDashboardUrl', () => {
  test('accepts the address alp dashboard prints, with its origin', () => {
    expect(validateDashboardUrl(GOOD)).toEqual({ url: GOOD, origin: 'http://127.0.0.1:7433' });
  });
  test.each([
    ['https', GOOD.replace('http:', 'https:')],
    ['localhost', GOOD.replace('127.0.0.1', 'localhost')],
    ['ipv6 loopback', GOOD.replace('127.0.0.1', '[::1]')],
    ['other host', GOOD.replace('127.0.0.1', '127.0.0.2')],
    ['remote host', `http://example.com:7433/#token=${TOKEN}`],
    ['userinfo', `http://user@127.0.0.1:7433/#token=${TOKEN}`],
    ['host smuggled before @', `http://127.0.0.1:7433@evil.test/#token=${TOKEN}`],
    ['path', `http://127.0.0.1:7433/x#token=${TOKEN}`],
    ['query', `http://127.0.0.1:7433/?a=1#token=${TOKEN}`],
    ['no port', `http://127.0.0.1/#token=${TOKEN}`],
    ['port 0', `http://127.0.0.1:0/#token=${TOKEN}`],
    ['port too large', `http://127.0.0.1:70000/#token=${TOKEN}`],
    ['leading zero port', `http://127.0.0.1:07433/#token=${TOKEN}`],
    ['short token', GOOD.slice(0, -1)],
    ['uppercase hex id', GOOD.replace('0123456789abcdef', '0123456789ABCDEF')],
    ['other prefix', GOOD.replace('alpgw1', 'alpgw2')],
    ['extra fragment param', `${GOOD}&x=1`],
    ['trailing text', `${GOOD} `],
    ['no token', 'http://127.0.0.1:7433/'],
    ['empty', ''],
  ])('refuses %s', (_name, text) => {
    expect(validateDashboardUrl(text)).toBeUndefined();
  });
});

describe('parseDashboardOutput', () => {
  test('takes the last non-empty line', () => {
    expect(parseDashboardOutput(`Starting alpd…\n${GOOD}\n\n`)?.url).toBe(GOOD);
  });
  test('refuses output whose last line is not an address', () => {
    expect(parseDashboardOutput(`${GOOD}\nsomething else\n`)).toBeUndefined();
    expect(parseDashboardOutput('')).toBeUndefined();
  });
});
