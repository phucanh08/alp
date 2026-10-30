// Settings › Diagnostics (lib/diagnostics.js): the report is built from named fields only, so
// nothing else on the state (the access token, prompts) can reach the text that gets copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticsSections, diagnosticsText } from '../src/lib/diagnostics.js';

const input = {
  version: '0.0.1-beta.6',
  connection: { phase: 'reconnecting', gateway: 'https://host.example', attempt: 3, daemonVersion: '0.0.1-beta.6', hostname: 'devbox', capabilities: ['terminal', 'library'], token: 'alpgw1.secret' },
  principal: { id: 'cred-1', label: 'Laptop', permissions: ['session.write', 'project.read'], workspaces: ['/a', '/b'], token: 'alpgw1.secret' },
  preferences: { theme: 'claude', contentMaxWidth: 1100, chatDisplay: 'full', sendBehavior: 'queue', newSession: { team: 'secret-team' } },
  browser: { userAgent: 'UA', language: 'vi-VN', online: true, secure: true, viewport: '1280×800 @2x', colorScheme: 'dark' },
  now: new Date('2026-10-30T00:00:00Z'),
};

test('the report names the app, browser, connection and token grants', () => {
  const text = diagnosticsText(input);
  assert.match(text, /^ALP web diagnostics, 2026-10-30T00:00:00.000Z/);
  for (const line of ['Version: ALP web v0.0.1-beta.6', 'State: reconnecting (attempt 3)', 'Host: devbox', 'Capabilities: library, terminal',
    'Permissions: project.read, session.write', 'Modes: any', 'Projects: 2', 'Theme: claude', 'Content width: 1100px', 'Chat display: full', 'Language: vi-VN', 'Secure context: yes']) {
    assert.ok(text.includes(line), line);
  }
  assert.deepEqual(diagnosticsSections(input).map(section => section.title), ['App', 'Browser', 'Connection', 'Access token']);
});

test('extra fields on the input never reach the report', () => {
  const text = diagnosticsText(input);
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /\/a|\/b/);
});

test('missing facts read as unknown', () => {
  const text = diagnosticsText({ ...input, principal: null, browser: undefined, connection: { phase: 'open', gateway: 'http://127.0.0.1:1', attempt: 1, capabilities: [] } });
  for (const line of ['User agent: unknown', 'Online: unknown', 'Host: unknown', 'Capabilities: none', 'Id: unknown', 'Projects: 0']) assert.ok(text.includes(line), line);
});
