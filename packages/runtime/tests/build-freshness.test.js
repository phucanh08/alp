import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// test-package.mjs builds workspace artifacts, not the legacy root bundles. Check the
// shared helper in an isolated process where root dist is unavailable, even if a
// developer's checkout happens to contain a previously built bundle.
test('scripted runtime tests do not depend on root dist bundles', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-runtime-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootDist = new URL('../../../dist/', import.meta.url).href;
  const helper = new URL('../../../test/support/fake-agent.js', import.meta.url).href;
  const loader = path.join(directory, 'no-root-dist.mjs');
  await writeFile(loader, `
    export async function resolve(specifier, context, nextResolve) {
      const result = await nextResolve(specifier, context);
      if (result.url.startsWith(${JSON.stringify(rootDist)})) {
        throw new Error('Runtime package tests must not load root dist: ' + result.url);
      }
      return result;
    }
  `);
  const register = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(register)}`,
    '--input-type=module', '--eval', `await import(${JSON.stringify(helper)})`], {
    encoding: 'utf8', env: process.env,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
