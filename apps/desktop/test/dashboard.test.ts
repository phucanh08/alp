import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDashboard, parsePrintAnswer } from '../src/dashboard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'alp-desktop-dashboard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
/** A fake alp: `--version` prints `version`; `dashboard --print` runs `body`. */
function fakeAlp(body: string, version = '0.0.1-beta.8') {
  const file = path.join(dir, `alp-${++count}`);
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version}'; exit 0; fi\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const USAGE = "printf 'Usage:\\n  alp <init|update-template> [directory]\\n  alp web [--print]\\n'";

describe('connectDashboard with an alp older than `alp dashboard` (t-81b0.7)', () => {
  test('usage on stderr and exit 1 (0.0.1-beta.8): says the alp is too old, with its version and path', async () => {
    const alp = fakeAlp(`${USAGE} >&2; exit 1`);
    const result = await connectDashboard(alp);
    expect(result).toEqual({ ok: false, error: `Your alp 0.0.1-beta.8 (${alp}) has no \`alp dashboard\`, which the ALP desktop app needs. Update ALP with \`alp update\`, or install a build from main.` });
  });
  test('usage on stdout and exit 0: the same message', async () => {
    const alp = fakeAlp(`${USAGE}; exit 0`);
    const result = await connectDashboard(alp);
    expect(result.ok).toBe(false);
    expect('error' in result && result.error).toStartWith('Your alp 0.0.1-beta.8 (');
  });
  test('a --version answer that is not a version is left out', async () => {
    const alp = fakeAlp(`${USAGE} >&2; exit 1`, 'Usage: alp ...');
    expect(await connectDashboard(alp)).toEqual({ ok: false, error: `Your alp (${alp}) has no \`alp dashboard\`, which the ALP desktop app needs. Update ALP with \`alp update\`, or install a build from main.` });
  });
  test("alp's own error is still shown as is", async () => {
    const alp = fakeAlp("echo 'error: alp dashboard is disabled' >&2; exit 1");
    expect(await connectDashboard(alp)).toEqual({ ok: false, error: 'alp dashboard is disabled' });
  });
});

const ADDRESS = `http://127.0.0.1:7433/#token=alpgw1.${'a'.repeat(16)}.${'B'.repeat(43)}`;
const answer = (body: Record<string, unknown>) => JSON.stringify({ schema: 'alp.dashboard.print', version: 1, ...body });
/** A fake alp with the contract: `dashboard --print --json` prints `line` and exits `code`; anything else is recorded as a failure. */
const jsonAlp = (line: string, code = 0, stderr = '') => fakeAlp([
  `[ "$1 $2 $3" = "dashboard --print --json" ] || { echo "unexpected: $*" >&2; exit 64; }`,
  stderr ? `echo '${stderr}' >&2` : ':',
  `printf '%s\\n' '${line}'`,
  `exit ${code}`,
].join('\n'));

describe('parsePrintAnswer: the JSON line of `alp dashboard --print --json` (t-81b0.4)', () => {
  test('success: the url, whatever other fields the line has', () => {
    expect(parsePrintAnswer(`${answer({ ok: true, url: ADDRESS, origin: 'http://127.0.0.1:7433', port: 7433, pid: 12, later: { field: 1 } })}\n`)).toEqual({ ok: true, url: ADDRESS });
  });
  test('failure: its code and message', () => {
    expect(parsePrintAnswer(answer({ ok: false, error: { code: 'disabled', message: 'alp dashboard is disabled' } }))).toEqual({ ok: false, code: 'disabled', message: 'alp dashboard is disabled' });
    expect(parsePrintAnswer(answer({ ok: false }))).toEqual({ ok: false, code: 'failed', message: '' });
  });
  test('another version is reported, not read', () => {
    expect(parsePrintAnswer(answer({ version: 2, ok: true, url: ADDRESS }))).toEqual({ unsupported: 2 });
  });
  test('not the contract: undefined', () => {
    for (const text of ['', ADDRESS, 'Usage:\n  alp …', '{', '[]', 'null', '{"ok":true}', JSON.stringify({ schema: 'other', version: 1, ok: true, url: ADDRESS }), answer({ ok: true }), answer({ ok: 'yes', url: ADDRESS })]) {
      expect(parsePrintAnswer(text)).toBeUndefined();
    }
  });
  test('only the last line counts', () => {
    expect(parsePrintAnswer(`${answer({ ok: true, url: ADDRESS })}\nsomething else\n`)).toBeUndefined();
  });
});

describe('connectDashboard reads `alp dashboard --print --json` (t-81b0.4)', () => {
  test('the address comes from the JSON', async () => {
    expect(await connectDashboard(jsonAlp(answer({ ok: true, url: ADDRESS, origin: 'http://127.0.0.1:7433', port: 7433, pid: 12 })))).toEqual({ ok: true, address: { url: ADDRESS, origin: 'http://127.0.0.1:7433' } });
  });
  test('a url that is not a loopback alp dashboard address is refused, whatever origin the JSON names', async () => {
    for (const url of ['https://example.com/#token=x', ADDRESS.replace('127.0.0.1', 'localhost'), `${ADDRESS}&x=1`, 'http://127.0.0.1:7433/']) {
      const result = await connectDashboard(jsonAlp(answer({ ok: true, url, origin: 'http://127.0.0.1:7433' })));
      expect(result).toEqual({ ok: false, error: '`alp dashboard --print` did not print an ALP dashboard address. Update ALP, then try again.' });
    }
  });
  test('ok:true with a failing exit code is not trusted', async () => {
    expect((await connectDashboard(jsonAlp(answer({ ok: true, url: ADDRESS }), 1))).ok).toBe(false);
  });
  test("a failure shows the JSON's message, not stderr", async () => {
    const alp = jsonAlp(answer({ ok: false, error: { code: 'disabled', message: 'alp dashboard is disabled by settings.' } }), 3, 'alp: something on stderr');
    expect(await connectDashboard(alp)).toEqual({ ok: false, error: 'alp dashboard is disabled by settings.' });
  });
  test('a failure without a message names its class and exit code', async () => {
    expect(await connectDashboard(jsonAlp(answer({ ok: false, error: { code: 'service' } }), 7))).toEqual({ ok: false, error: 'alp dashboard failed (service, exit code 7)' });
  });
  test('a newer version of the format: the app says it must be updated', async () => {
    const alp = jsonAlp(answer({ version: 2, ok: true, url: ADDRESS }));
    expect(await connectDashboard(alp)).toEqual({ ok: false, error: `Your alp (${alp}) answers \`alp dashboard --print --json\` in version 2 of its format; this ALP desktop app reads version 1. Update the ALP desktop app.` });
  });
  test('exit 0 and a bare address on --json is not the contract: refused', async () => {
    const result = await connectDashboard(fakeAlp(`printf '%s\\n' '${ADDRESS}'`));
    expect(result).toEqual({ ok: false, error: '`alp dashboard --print` did not print an ALP dashboard address. Update ALP, then try again.' });
  });
  test('no JSON and no usage: stderr is shown as before', async () => {
    expect(await connectDashboard(fakeAlp("echo 'error: node: not found' >&2; exit 127"))).toEqual({ ok: false, error: 'node: not found' });
  });
});

describe('connectDashboard with an alp from before --json (0.0.1-beta.9 to beta.13) (t-81b0.4)', () => {
  /** As cli.js of beta.13: an unknown option prints the usage text and exits 1; `dashboard --print` runs `body`. */
  const legacyAlp = (body: string) => fakeAlp([
    `if [ "$3" = --json ]; then ${USAGE.replace('alp web [--print]', 'alp dashboard [--no-open|--print]')} >&2; exit 1; fi`,
    `[ "$1 $2" = "dashboard --print" ] || exit 64`,
    body,
  ].join('\n'));
  test('falls back to `alp dashboard --print` and reads the address from its last line', async () => {
    expect(await connectDashboard(legacyAlp(`echo 'Moved files' >&2; printf '%s\\n' '${ADDRESS}'`))).toEqual({ ok: true, address: { url: ADDRESS, origin: 'http://127.0.0.1:7433' } });
  });
  test("its own error is shown as is", async () => {
    expect(await connectDashboard(legacyAlp("echo 'error: alp dashboard is disabled' >&2; exit 1"))).toEqual({ ok: false, error: 'alp dashboard is disabled' });
  });
  test('an address that is not loopback is refused there too', async () => {
    expect((await connectDashboard(legacyAlp("printf '%s\\n' 'https://example.com/#token=x'"))).ok).toBe(false);
  });
});
