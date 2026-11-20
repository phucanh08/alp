import { afterAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeDashboard } from '../src/dashboard';

const servers: http.Server[] = [];
afterAll(() => { for (const server of servers) server.close(); });

function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe('probeDashboard', () => {
  test('any HTTP answer counts, 503 (alpd not ready) included; GET /readyz with no credential', async () => {
    const seen: { url?: string; method?: string; authorization?: string }[] = [];
    const origin = await serve((request, response) => {
      seen.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
      response.writeHead(seen.length === 1 ? 200 : 503).end('{}');
    });
    expect(await probeDashboard(origin)).toBe(true);
    expect(await probeDashboard(origin)).toBe(true);
    expect(seen).toEqual([{ url: '/readyz', method: 'GET', authorization: undefined }, { url: '/readyz', method: 'GET', authorization: undefined }]);
  });
  test('a refused connection is no answer', async () => {
    const origin = await serve((_request, response) => response.end());
    servers.at(-1)!.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await probeDashboard(origin)).toBe(false);
  });
  test('a server that never answers is no answer once the timeout passes', async () => {
    const origin = await serve(() => { /* never answers */ });
    const started = Date.now();
    expect(await probeDashboard(origin, 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    servers.at(-1)!.closeAllConnections();
  });
});
