#!/usr/bin/env node
// Every relative specifier a module reaches for, and which of them are not on disk (t-5294.6).
//
// Two scripts copy test files out of this repository into an isolated project — a tarball consumer
// and the standalone core smoke — and copy their support modules one by one beside them. When a
// test gains a support import, the copy silently stops resolving: the whole suite then dies with an
// ERR_MODULE_NOT_FOUND 180 s into `node --test`, pointing at a temporary directory and not at the
// copy that forgot the file. t-5294.6 did exactly that, twice, by adding
// `import { teardown } from '.../test/support/teardown.js'` to files both scripts copy.
//
// So the copy checks itself. Parsed, not grepped: a specifier can be single- or double-quoted, and
// it can arrive as a named, default, namespace or side-effect import, an `export ... from`, or a
// dynamic `import()` — a regular expression over `from '...'` misses four of those six.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/** Every relative module specifier in `source`, in source order, with duplicates removed. */
export function relativeSpecifiers(source, fileName = 'module.mjs') {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Set();
  const take = node => {
    if (node && ts.isStringLiteral(node) && node.text.startsWith('.')) found.add(node.text);
  };
  const walk = node => {
    // `import x from './a.js'`, `import './a.js'`, `import * as x from './a.js'`, `export * from './a.js'`
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) take(node.moduleSpecifier);
    // `await import('./a.js')` and `import.meta.resolve('./a.js')`
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) take(node.arguments[0]);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve'
          && ts.isMetaProperty(node.expression.expression)) take(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return [...found];
}

/**
 * The relative imports of `file` that do not exist next to it: what a copy step forgot to bring.
 * A specifier without an extension is reported as missing only if no candidate resolves, since
 * these are ES modules where the extension is normally written out.
 */
export async function missingRelativeImports(file) {
  const source = await readFile(file, 'utf8');
  return relativeSpecifiers(source, file).filter(specifier => {
    const target = path.resolve(path.dirname(file), specifier);
    return ![target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')].some(existsSync);
  });
}

/** Throws naming the file, the specifier and what to do, or returns quietly. */
export async function requireRelativeImports(file, what) {
  const missing = await missingRelativeImports(file);
  if (missing.length) {
    throw new Error(`${path.basename(file)} imports ${missing.join(', ')}, which ${what} does not copy into the isolated project. Copy the file(s) beside it; otherwise this suite dies on ERR_MODULE_NOT_FOUND before a single test runs.`);
  }
}
