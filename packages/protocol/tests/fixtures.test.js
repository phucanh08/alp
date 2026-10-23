import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const generator = new URL('../scripts/fixtures.mjs', import.meta.url);
const golden = new URL('../fixtures/v1/cases.json', import.meta.url);

test('the fixture generator reproduces every golden case byte for byte', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'alp-protocol-fixtures-'));
  try {
    const output = path.join(scratch, 'cases.json');
    const generated = spawnSync(process.execPath, [fileURLToPath(generator), output], {
      encoding: 'utf8',
      env: { ...process.env, ALP_HOME: path.join(scratch, 'home') },
    });
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
    assert.ok((await readFile(output)).equals(await readFile(golden)),
      'Fixture drift: edit scripts/fixtures.mjs and regenerate fixtures/v1/cases.json together');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
