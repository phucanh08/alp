// t-fa0a.8 (from the t-fa0a.7 review): scripts/spawn-command.ts removes pnpm's npm_config_* settings
// from process.env when it is first imported (clearPnpmConfig), so an npm started by a script reads
// only its own config. That cleanup is a side effect of the import, so a script that starts npm, npx
// or pnpm without importing spawn-command would hand npm pnpm's settings again (warnings on stderr
// that some callers parse with stdout). Every such script must import it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm']);

/** The package managers a source names as a string literal, and whether it imports ./spawn-command.ts. */
export function packageManagerUse(file: string, text: string): { names: string[]; imports: boolean } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  let imports = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './spawn-command.ts') imports = true;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PACKAGE_MANAGERS.has(node.text) && !ts.isImportDeclaration(node.parent)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names: [...names].sort(), imports };
}

test('every script that starts npm, npx or pnpm imports scripts/spawn-command.ts', () => {
  const scripts = readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts') && name !== 'spawn-command.ts');
  const users: string[] = [];
  const missing: string[] = [];
  for (const name of scripts) {
    const use = packageManagerUse(name, readFileSync(path.join(root, 'scripts', name), 'utf8'));
    if (!use.names.length) continue;
    users.push(name);
    if (!use.imports) missing.push(`scripts/${name} (${use.names.join(', ')})`);
  }
  // The scan must still see the scripts it guards: a parser or naming change that found none would pass vacuously.
  assert.ok(users.includes('release-pack.ts') && users.includes('build-bundle.ts'), `the scan found: ${users.join(', ')}`);
  assert.deepEqual(missing, [], 'these scripts start a package manager without importing ./spawn-command.ts');
});

test('the scan tells a script that starts npm from one that only mentions it', () => {
  assert.deepEqual(packageManagerUse('a.ts', "import { spawnSync } from 'node:child_process';\nspawnSync('npm', ['pack']);\n"), { names: ['npm'], imports: false });
  assert.deepEqual(packageManagerUse('b.ts', "import { spawnCommand } from './spawn-command.ts';\nrun(...spawnCommand('pnpm', ['install']));\n"), { names: ['pnpm'], imports: true });
  assert.deepEqual(packageManagerUse('c.ts', "// npm and 'npx' in a comment\nconst text = 'run npm pack';\n"), { names: [], imports: false });
});
