#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { builtinModules } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const graph = new Map();
const allowed = {
  '@anhlp/alp-protocol': [],
  '@anhlp/alp-core': ['@anhlp/alp-protocol'],
  '@anhlp/alp-runtime': ['@anhlp/alp-core', '@anhlp/alp-protocol'],
  '@anhlp/alp-client': ['@anhlp/alp-core', '@anhlp/alp-protocol'],
  '@anhlp/alp-daemon': ['@anhlp/alp-runtime', '@anhlp/alp-core', '@anhlp/alp-client', '@anhlp/alp-protocol'],
  '@anhlp/alp-cli': ['@anhlp/alp-client', '@anhlp/alp-core', '@anhlp/alp-protocol'],
  '@anhlp/alp-tui': [],
  'alp-paseo-plugin': ['@anhlp/alp-daemon', '@anhlp/alp-runtime', '@anhlp/alp-client', '@anhlp/alp-core', '@anhlp/alp-protocol'],
};
const failures = [];
for (const location of manifest.workspaces) {
  const directory = path.join(root, location);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
  const edges = Object.keys(declared).filter(name => name.startsWith('@anhlp/alp-'));
  graph.set(pkg.name, edges);
  for (const dep of edges) if (!(allowed[pkg.name] ?? []).includes(dep)) failures.push(`${pkg.name}: forbidden package dependency ${dep}`);
  const files = await readdir(directory, { recursive: true });
  for (const relative of files.filter(file => /\.(?:ts|tsx|js)$/.test(file) && !file.startsWith('dist/') && !file.includes('/dist/'))) {
    const text = await readFile(path.join(directory, relative), 'utf8');
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
    const specifiers = [];
    function inspect(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(directory, path.dirname(relative), specifier);
        if (!target.startsWith(directory + path.sep)) failures.push(`${location}/${relative}: relative import escapes package: ${specifier}`);
      } else if (!specifier.startsWith('node:') && !specifier.startsWith('alp:') && !builtinModules.includes(specifier)) {
        const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (dependency !== pkg.name && !declared[dependency]) failures.push(`${location}/${relative}: undeclared dependency ${dependency}`);
        if ((pkg.name.endsWith('-core') || pkg.name.endsWith('-protocol')) && !dependency.startsWith('@anhlp/alp-protocol')) failures.push(`${pkg.name}: leaf domain imports ${dependency}`);
      }
    }
  }
}
const done = new Set();
function visit(name, stack = []) {
  if (stack.includes(name)) { failures.push(`Dependency cycle: ${[...stack, name].join(' -> ')}`); return; }
  if (done.has(name)) return;
  for (const dep of graph.get(name) ?? []) visit(dep, [...stack, name]);
  done.add(name);
}
for (const name of graph.keys()) visit(name);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Validated ${graph.size} workspace dependency boundaries (no cycles).`);
