import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runHook } from '../../packages/core/src/hook-run.js';
import { checkBoundaries, globRegExp, importsOf } from '../../templates/skills/feature-architecture/scripts/check-boundaries.mjs';

const CHECKER = fileURLToPath(new URL('../../templates/skills/feature-architecture/scripts/check-boundaries.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/architecture-app/', import.meta.url));
const run = promisify(execFile);

/** The checker as an agent or CI runs it: exit code and output. */
async function check(root, ...args) {
  try { const { stdout, stderr } = await run(process.execPath, [CHECKER, '--root', root, ...args]); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-arch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(FIXTURE, root, { recursive: true });
  return root;
}

/** A feature made from the project's boilerplate, as feature-architecture step 4 tells an agent to. */
async function featureFromTemplate(root, name) {
  const Name = name[0].toUpperCase() + name.slice(1);
  const fill = async (template, target) => {
    const text = (await readFile(path.join(root, 'templates/features/__name__', template), 'utf8')).replaceAll('__Name__', Name).replaceAll('__name__', name);
    await writeFile(path.join(root, target), text);
  };
  await fill('domain.ts.tpl', `src/domain/${name}.ts`);
  await fill('app.ts.tpl', `src/app/create-${name}.ts`);
  await fill('api.ts.tpl', `src/api/${name}s.ts`);
}

test('the checker reads every import form, ignoring comments and strings that are not imports', () => {
  const text = [
    "import a from './a.js';", "import {", "  b,", "} from '../b.js';", "export * from './c.js';", "import './side.js';",
    "const d = await import('./d.js');", "const e = require('e-pkg/sub');", "// import x from './commented.js';",
    "/* import y from './block.js'; */", "const s = 'import z from \"./in-string.js\"';", "obj.import('./method.js');",
  ].join('\n');
  assert.deepEqual(importsOf(text).map(i => [i.specifier, i.line]), [['./a.js', 1], ['../b.js', 4], ['./c.js', 5], ['./side.js', 6], ['./d.js', 7], ['e-pkg/sub', 8]]);
  assert.ok(globRegExp('src/**').test('src/a/b.ts') && globRegExp('**/*.test.ts').test('src/x.test.ts') && !globRegExp('src/*').test('src/a/b.ts'));
});

test('the boilerplate project passes, and a feature built from its template passes too', async t => {
  const root = await project(t);
  const clean = await check(root);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /4 file\(s\) checked against docs\/architecture\/contract\.json: 0 violation/);
  await featureFromTemplate(root, 'invoice');
  const valid = await check(root);
  assert.equal(valid.code, 0, valid.stdout);
  assert.match(valid.stdout, /7 file\(s\) checked/);
});

test('a dependency against the layering and a forbidden package are reported with file and line', async t => {
  const root = await project(t);
  await featureFromTemplate(root, 'invoice');
  // The deliberate violation: the domain reaches up into the API layer, and pulls in a framework.
  await writeFile(path.join(root, 'src/domain/invoice.ts'), "import { id } from '../shared/id.js';\nimport { postOrder } from '../api/orders.js';\nimport express from 'express';\nexport const x = [id, postOrder, express];\n");
  const broken = await check(root);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /^src\/domain\/invoice\.ts:2 {2}domain -> api \(\.\.\/api\/orders\.js\): domain may import only shared$/m);
  assert.match(broken.stdout, /^src\/domain\/invoice\.ts:3 {2}domain -> express \(express\): domain must not import package express$/m);
  const json = JSON.parse((await check(root, '--json')).stdout);
  assert.deepEqual(json.violations.map(v => [v.file, v.line, v.from, v.to]), [['src/domain/invoice.ts', 2, 'domain', 'api'], ['src/domain/invoice.ts', 3, 'domain', 'express']]);
});

test('an exception needs a reason and an approver; a recorded one lets the import pass and is listed', async t => {
  const root = await project(t);
  await writeFile(path.join(root, 'src/domain/legacy.ts'), "import { postOrder } from '../api/orders.js';\nexport const legacy = postOrder;\n");
  const contractFile = path.join(root, 'docs/architecture/contract.json');
  const contract = JSON.parse(await readFile(contractFile, 'utf8'));
  await writeFile(contractFile, JSON.stringify({ ...contract, exceptions: [{ file: 'src/domain/legacy.ts', import: 'src/api/**', reason: 'predates layering' }] }));
  const unapproved = await check(root);
  assert.equal(unapproved.code, 2);
  assert.match(unapproved.stderr, /exceptions\[0\]\.approvedBy is required/);
  await writeFile(contractFile, JSON.stringify({ ...contract, exceptions: [{ file: 'src/domain/legacy.ts', import: 'src/api/**', reason: 'predates layering', approvedBy: 'main, 2026-11-05' }] }));
  const excepted = await check(root);
  assert.equal(excepted.code, 0, excepted.stdout);
  assert.match(excepted.stdout, /src\/domain\/legacy\.ts:1 {2}domain -> api: allowed by exception \(predates layering; approved by main, 2026-11-05\)/);
  // A malformed contract or a missing one is an error, not a pass.
  await writeFile(contractFile, JSON.stringify({ modules: {} }));
  assert.equal((await check(root)).code, 2);
  assert.equal((await check(root, '--contract', 'missing.json')).code, 2);
  assert.equal((await check(root, '--bogus')).code, 2);
});

test('as a blocking hook the checker refuses with the violation as its reason, and passes a valid tree', async t => {
  const root = await project(t);
  // The contract reference: CI and hooks run a copy kept in the repository.
  await mkdir(path.join(root, 'tools'));
  await cp(CHECKER, path.join(root, 'tools/check-boundaries.mjs'));
  const hook = { event: 'handoff', command: 'node tools/check-boundaries.mjs', blocking: true, timeoutSec: 60 };
  assert.equal((await runHook(hook, { event: 'handoff' }, { cwd: root })).exitCode, 0);
  await writeFile(path.join(root, 'src/app/report.ts'), "import { postOrder } from '../api/orders.js';\nexport const r = postOrder;\n");
  const refused = await runHook(hook, { event: 'handoff' }, { cwd: root });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /src\/app\/report\.ts:1 {2}app -> api/);
});

test('checkBoundaries is usable as a library on an in-memory contract', async t => {
  const root = await project(t);
  const result = await checkBoundaries(root, { modules: { api: ['src/api/**'], domain: ['src/domain/**'] }, allow: { domain: [] } });
  assert.deepEqual(result.violations, []);
  assert.equal(result.files, 3);
});
