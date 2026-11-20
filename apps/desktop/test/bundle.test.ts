import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dir, '..');

// t-81b0.7: `bun build` writes the build machine's directory into the bundle for __dirname and
// import.meta (dir, path, url), so the packaged app looked for its pages on the CI runner. The
// bundle, built as package.json's build script does, must not hold any path of the build tree.
test('dist/main.cjs holds no absolute path of the machine that built it', async () => {
  const built = await Bun.build({ entrypoints: [path.join(APP, 'src', 'main.ts')], target: 'node', format: 'cjs', external: ['electron'] });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]!.text();
  for (const dir of new Set([APP, realpathSync(APP)])) expect(code.includes(dir)).toBe(false);
  expect(code).not.toMatch(/\bvar __(dirname|filename) = "/);
});
