import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDashboard } from '../src/dashboard';

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
