// t-37f1: `npm run version:package` bumps the @anhlp/alp wrapper (npm/alp, not a workspace) with
// @anhlp/alp-cli, and leaves it alone for any other package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/version-package.mjs', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); };

async function repo(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(path.join(root, 'package.json'), { name: 'alp', private: true, workspaces: ['packages/cli', 'packages/client'], dependencies: { '@anhlp/alp-cli': '1.0.0' } });
  await put(path.join(root, 'packages/cli/package.json'), { name: '@anhlp/alp-cli', version: '1.0.0', dependencies: { '@anhlp/alp-client': '1.0.0' } });
  await put(path.join(root, 'packages/client/package.json'), { name: '@anhlp/alp-client', version: '1.0.0' });
  await put(path.join(root, 'npm/alp/package.json'), { name: '@anhlp/alp', version: '1.0.0', dependencies: { '@anhlp/alp-cli': '1.0.0' } });
  return root;
}
const bump = (root, name, version) => execFileSync(process.execPath, [SCRIPT, name, version], { env: { ...process.env, ALP_VERSION_PACKAGE_ROOT: root, ALP_VERSION_PACKAGE_SKIP_LOCK: '1' } });

test('version:package moves the wrapper to the new @anhlp/alp-cli version and pins it exactly', async t => {
  const root = await repo(t);
  bump(root, '@anhlp/alp-cli', '1.2.0-beta.3');
  const wrapper = await json(path.join(root, 'npm/alp/package.json'));
  assert.equal(wrapper.version, '1.2.0-beta.3');
  assert.equal(wrapper.dependencies['@anhlp/alp-cli'], '1.2.0-beta.3');
  assert.equal((await json(path.join(root, 'packages/cli/package.json'))).version, '1.2.0-beta.3');
  assert.equal((await json(path.join(root, 'package.json'))).dependencies['@anhlp/alp-cli'], '1.2.0-beta.3');
});

test('version:package leaves the wrapper alone when another package is bumped', async t => {
  const root = await repo(t);
  bump(root, '@anhlp/alp-client', '1.1.0');
  assert.deepEqual(await json(path.join(root, 'npm/alp/package.json')), { name: '@anhlp/alp', version: '1.0.0', dependencies: { '@anhlp/alp-cli': '1.0.0' } });
  assert.equal((await json(path.join(root, 'packages/cli/package.json'))).dependencies['@anhlp/alp-client'], '1.1.0');
});
