import test from 'node:test';
import assert from 'node:assert/strict';
import { openTerminalLink } from '../dist-lib/terminal-links.js';
test('terminal links open web URLs with opener isolation and reject executable/credential URLs', () => {
  const calls: unknown[][] = [];
  const open = (...args: unknown[]) => calls.push(args);
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:password@example.com', '/relative', 'oops']) assert.equal(openTerminalLink(url, open), false);
  assert.equal(calls.length, 0);
  assert.equal(openTerminalLink('https://example.com/path?q=1', open), true);
  assert.deepEqual(calls, [['https://example.com/path?q=1', '_blank', 'noopener,noreferrer']]);
});
