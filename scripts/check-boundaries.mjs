#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { corePackageProblems } from './core-package-boundary.mjs';
import { builtinModules } from 'node:module';
import { coreManifestPaths, validateBuildManifest } from './build-manifest.mjs';

// The default root is this repository; tests point --root at a throwaway fixture to prove the
// checker catches forbidden dependencies, imports and require aliases without touching the tree.
const argument = process.argv.indexOf('--root');
const root = path.resolve(argument >= 0 && process.argv[argument + 1] ? process.argv[argument + 1] : path.join(import.meta.dirname, '..'));
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
  '@anhlp/alp-gateway': ['@anhlp/alp-client', '@anhlp/alp-core', '@anhlp/alp-protocol'],
  'alp-paseo-plugin': ['@anhlp/alp-daemon', '@anhlp/alp-runtime', '@anhlp/alp-client', '@anhlp/alp-core', '@anhlp/alp-protocol'],
};
const failures = corePackageProblems(manifest);
const supportDirectory = path.join(root, 'test', 'support');

/** Names bound to createRequire(...) so an aliased require('...') is caught like a bare one. */
function requireAliases(source) {
  const names = new Set(['require']);
  function inspect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (called === 'createRequire' || called === 'createRequireFromPath') names.add(node.name.text);
    }
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:module') {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'createRequire') names.add(element.name.text);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  return names;
}

// Where each workspace lives: libraries under packages/, external integrations under integrations/, applications under apps/.
// Nothing may depend on an integration or an application, so no package gains a reverse dependency on one.
const locationOf = new Map();
for (const location of manifest.workspaces ?? []) {
  try { locationOf.set(JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8')).name, location); } catch {}
}
for (const location of manifest.workspaces ?? []) {
  const directory = path.join(root, location);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== 'alp-paseo-plugin') failures.push(...corePackageProblems(pkg));
  const declared = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  const edges = Object.keys(declared).filter(name => name.startsWith('@anhlp/alp-'));
  graph.set(pkg.name, edges);
  for (const dep of edges) if (!(allowed[pkg.name] ?? []).includes(dep)) failures.push(`${pkg.name}: forbidden package dependency ${dep}`);
  for (const name of Object.keys(declared)) {
    const target = locationOf.get(name);
    if (target && /^(integrations|apps)\//.test(target)) failures.push(`${pkg.name}: depends on ${name}, which lives in ${target} (integrations and apps are leaves)`);
  }
  if (pkg.name !== 'alp-paseo-plugin') {
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })) {
      if (dep.startsWith('@getpaseo') || dep === 'alp-paseo-plugin') failures.push(`${pkg.name}: forbidden Paseo dependency ${dep}`);
    }
  }
  const files = await readdir(directory, { recursive: true });
  for (const relative of files.filter(file => /\.(?:ts|tsx|js)$/.test(file) && !file.startsWith('dist/') && !file.includes('/dist/'))) {
    const text = await readFile(path.join(directory, relative), 'utf8');
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
    const aliases = requireAliases(source);
    const specifiers = [];
    function inspect(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    for (const specifier of specifiers) {
      if ((pkg.name !== 'alp-paseo-plugin') && specifier.startsWith('@getpaseo')) failures.push(`${location}/${relative}: forbidden @getpaseo dependency in core package: ${specifier}`);
      if (specifier.startsWith('.')) {
        const target = path.resolve(directory, path.dirname(relative), specifier);
        // A package's own tests may share the repository's fixture transports in test/support, and nothing else outside the package.
        const shared = relative.startsWith(`tests${path.sep}`) && (target === supportDirectory || target.startsWith(supportDirectory + path.sep));
        if (!target.startsWith(directory + path.sep) && target !== directory && !shared) failures.push(`${location}/${relative}: relative import escapes package: ${specifier}`);
      } else if (!specifier.startsWith('node:') && !specifier.startsWith('alp:') && !builtinModules.includes(specifier)) {
        const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (dependency !== pkg.name && !declared[dependency]) failures.push(`${location}/${relative}: undeclared dependency ${dependency}`);
        if (!relative.startsWith(`tests${path.sep}`) && (pkg.name.endsWith('-core') || pkg.name.endsWith('-protocol')) && !dependency.startsWith('@anhlp/alp-protocol')) failures.push(`${pkg.name}: leaf domain imports ${dependency}`);
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

// Packed core artifacts must also be free of optional Paseo dependencies.
const artifactPackages = ['protocol', 'core', 'runtime', 'client', 'daemon', 'cli'];
for (const name of artifactPackages) {
  const directory = path.join(root, 'packages', name, 'dist');
  try {
    const files = await readdir(directory, { recursive: true });
    for (const relative of files.filter(file => /\.(?:[cm]?js|ts|json)$/.test(file))) {
      const text = await readFile(path.join(directory, relative), 'utf8');
      if (text.includes('@getpaseo')) failures.push(`packages/${name}/dist/${relative}: packed artifact contains @getpaseo`);
    }
  } catch (error) { if (process.argv.includes('--require-artifacts')) failures.push(`Missing or unreadable build artifact: ${error.message}`); }
}
// Root bundles carrying alpd/acp must not embed Paseo.
for (const file of ['dist/alpd.js', 'dist/acp.js', 'dist/acp/agent.js', 'dist/runtime/index.js', 'dist/daemon/index.js', 'packages/cli/dist/alpd.js', 'packages/cli/dist/acp.js']) {
  try {
    const text = await readFile(path.join(root, file), 'utf8');
    if (text.includes('@getpaseo')) failures.push(`${file}: packed artifact contains @getpaseo`);
  } catch (error) { if (process.argv.includes('--require-artifacts')) failures.push(`Missing or unreadable build artifact: ${error.message}`); }
}
// Every core build writes a manifest of each canonical bundle's inputs and externals (root
// runtime/daemon/alpd/acp, plus the workspace daemon and CLI alpd/acp outputs); validate them all.
for (const manifestFile of coreManifestPaths(root)) {
  try {
    failures.push(...validateBuildManifest(JSON.parse(await readFile(manifestFile, 'utf8'))));
  } catch (error) { if (process.argv.includes('--require-artifacts')) failures.push(`Missing or unreadable build artifact: ${error.message}`); }
}

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Validated ${graph.size} workspace dependency boundaries (no cycles).`);
