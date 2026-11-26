import ts from 'typescript';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './workspace-build-lib.ts';

/**
 * Emit only this package's declarations, while resolving dependency types from workspace sources.
 */
export async function emitDeclarations(directory: string, files: string[]) {
  const roots = files.filter(file => /\.(ts|js)$/.test(file)).map(file => path.join(directory, 'src', file));
  const output = path.join(ROOT, '.cache/workspace-declarations');
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, allowJs: true, checkJs: false, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
    noEmitOnError: true, rootDir: ROOT,
    // Sources may name siblings with `.ts` specifiers (Node runs them directly); the .d.ts must name `.js`.
    allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true, outDir: output, customConditions: ['alp-source'], types: ['node'],
  };
  const program = ts.createProgram(roots, options);
  const writes: Promise<void>[] = [];
  const prefix = path.join(output, path.relative(ROOT, directory), 'src') + path.sep;
  // TypeScript 5.9 does not rewrite relative `.ts` specifiers in declarations: map them to `.js` here
  // (`from '…'`, `import('…')`, a bare `import '…'`, `export … from '…'`; never a `.d.ts` path).
  const jsSpecifiers = (text: string) => text.replace(/((?:from|import\(|import)\s*)(['"])(\.\.?\/[^'"]+?)(?<!\.d)\.ts\2/g, '$1$2$3.js$2');
  const result = program.emit(undefined, (emitted, content) => {
    // TypeScript names files with `/`; on Windows the prefix has `\`.
    const file = path.normalize(emitted);
    if (!file.startsWith(prefix)) return;
    const destination = path.join(directory, 'dist', file.slice(prefix.length));
    writes.push((async () => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, jsSpecifiers(content)); })());
  });
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => ROOT, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
  await Promise.all(writes);
  // Preserve manually maintained declarations for existing JS APIs.
  for (const file of files.filter(file => file.endsWith('.d.ts'))) {
    await mkdir(path.dirname(path.join(directory, 'dist', file)), { recursive: true });
    await cp(path.join(directory, 'src', file), path.join(directory, 'dist', file));
  }
}
