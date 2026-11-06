// t-ffe4.4: release acceptance must run both halves of the #111 check on every row. Its
// release-consumer step runs scripts/paseo-source-check.mjs, whose compile half (Paseo's own plugin
// compiler) needs the checkout scripts/paseo-checkout.mjs makes. The workflow never made it, so every
// row printed "Paseo compiler skipped (no Paseo checkout …)" and the release gate passed without ever
// compiling the packed plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/release-acceptance.yml'), 'utf8');

/** The acceptance job's text, from its key to the next top-level job (or the end). */
function job(name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${name}:`);
  assert.ok(start >= 0, `no ${name} job in release-acceptance.yml`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

test('release acceptance checks out Paseo\'s compiler before release-consumer and requires it', () => {
  const lines = job('acceptance');
  const checkout = lines.findIndex(line => /^\s+run: node scripts\/paseo-checkout\.mjs\s*$/.test(line));
  const consumer = lines.findIndex(line => /^\s+- run: npm run release:consumer\b/.test(line));
  assert.ok(consumer >= 0, 'the acceptance job no longer runs release:consumer');
  assert.ok(checkout >= 0, 'the acceptance job never runs scripts/paseo-checkout.mjs: the #111 compile half is skipped on every row');
  assert.ok(checkout < consumer, 'scripts/paseo-checkout.mjs must run before release:consumer');
  // Job-level env (four-space key under the job), so every step that reaches paseo-source-check has it.
  const env = lines.findIndex(line => line === '    env:');
  assert.ok(env >= 0, 'the acceptance job has no env block');
  const required = lines.slice(env + 1).findIndex(line => /^ {6}ALP_REQUIRE_PASEO_COMPILER: ['"]?1['"]?\s*$/.test(line));
  const nextKey = lines.slice(env + 1).findIndex(line => /^ {4}\S/.test(line));
  assert.ok(required >= 0 && (nextKey < 0 || required < nextKey), 'the acceptance job must set ALP_REQUIRE_PASEO_COMPILER=1: a missing compiler would be skipped, not fail the row');
});

/** paseoCompile in a fresh Node, with `env` and no Paseo checkout at ALP_PASEO_SRC. */
function compileWithoutCheckout(t, env) {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'alp-no-paseo-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const script = `import(${JSON.stringify(new URL('../../scripts/paseo-source-check.mjs', import.meta.url).href)}).then(m => m.paseoCompile(${JSON.stringify(empty)})).then(r => console.log(JSON.stringify(r)), e => { console.error(e.message); process.exit(7); });`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, ALP_PASEO_SRC: empty, GITHUB_ACTIONS: 'true', ...env } });
}

test('with ALP_REQUIRE_PASEO_COMPILER=1 a missing Paseo checkout fails the check', t => {
  const result = compileWithoutCheckout(t, { ALP_REQUIRE_PASEO_COMPILER: '1' });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stderr, /Paseo's plugin compiler is missing at .*run scripts\/paseo-checkout\.mjs first/);
});

test('without it a skip is loud: it says the compile was not checked, and warns in GitHub Actions', t => {
  const result = compileWithoutCheckout(t, { ALP_REQUIRE_PASEO_COMPILER: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^::warning title=Paseo compiler not run \(#111\)::/m);
  assert.match(JSON.parse(result.stdout.trim().split('\n').at(-1)).skipped, /NOT checked/);
});
