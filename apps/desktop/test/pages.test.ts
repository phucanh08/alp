import { describe, expect, test } from 'bun:test';
import { isPageUrl, pageUrl, resolvePage } from '../src/pages';

const DIR = '/App/ALP.app/Contents/Resources/app.asar/dist/pages';

describe('bundled pages (alp-page://app, t-81b0.7)', () => {
  test('pageUrl carries the query as search parameters, encoded', () => {
    expect(pageUrl('connecting.html')).toBe('alp-page://app/connecting.html');
    expect(pageUrl('error.html', { message: 'a b&c=d' })).toBe('alp-page://app/error.html?message=a+b%26c%3Dd');
    expect(isPageUrl(pageUrl('error.html'))).toBe(true);
    expect(isPageUrl('http://127.0.0.1:1/')).toBe(false);
  });
  test('each bundled file resolves under the pages directory, with its type; a query does not matter', () => {
    expect(resolvePage('alp-page://app/error.html?message=x', DIR)).toEqual({ file: `${DIR}/error.html`, type: 'text/html; charset=utf-8' });
    expect(resolvePage('alp-page://app/page.css', DIR)).toEqual({ file: `${DIR}/page.css`, type: 'text/css; charset=utf-8' });
    expect(resolvePage('alp-page://app/missing-alp.js', DIR)?.type).toBe('text/javascript; charset=utf-8');
  });
  test('anything else is not served', () => {
    for (const url of [
      'alp-page://app/', 'alp-page://app/other.html', 'alp-page://app/../main.cjs', 'alp-page://app/%2e%2e/main.cjs',
      'alp-page://app/pages/error.html', 'alp-page://other/error.html', 'alp-page://u:p@app/error.html',
      'alp-page://app/%2Fetc%2Fpasswd', 'alp-page://app/..%2Fmain.cjs', 'alp-page://app/%2e%2e%2fmain.cjs', 'alp-page://app/error.html%00',
      'alp-page://app//etc/passwd', 'alp-page://app/etc/passwd', 'alp-page://app/C:%5Cerror.html', 'alp-page://app/..%5Cerror.html',
      'alp-page://app/./error.html/', 'alp-page://app/ERROR.HTML', 'alp-page:error.html',
      'file:///etc/passwd', 'http://app/error.html', 'alp-page://app/toString', 'alp-page://app/__proto__', 'not a url',
    ]) expect(resolvePage(url, DIR)).toBeUndefined();
  });
});
