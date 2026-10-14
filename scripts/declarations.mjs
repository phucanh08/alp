import ts from 'typescript';
import { mkdir, writeFile, cp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './workspace-build-lib.mjs';

/** Emit only this package's declarations, while resolving dependency types from workspace sources. */
export async function emitDeclarations(directory, files) {
  const roots = files.filter(file => /\.(ts|js)$/.test(file)).map(file => path.join(directory, 'src', file));
  roots.push(path.join(ROOT, 'integrations/paseo/server/alp-templates.d.ts'));
  const output = path.join(ROOT, '.cache/workspace-declarations');
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, allowJs: true, checkJs: false, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
    noEmitOnError: true, rootDir: ROOT, outDir: output, customConditions: ['alp-source'], types: ['node'],
  };
  const program = ts.createProgram(roots, options);
  const writes = [];
  const prefix = path.join(output, path.relative(ROOT, directory), 'src') + path.sep;
  const result = program.emit(undefined, (file, content) => {
    if (!file.startsWith(prefix)) return;
    const destination = path.join(directory, 'dist', file.slice(prefix.length));
    writes.push((async () => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, content); })());
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

async function walkTypeScript(directory) {
  const found = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    found.push(path.join(entry.parentPath, entry.name));
  }
  return found.sort();
}

/**
 * Emit the Paseo plugin's server and shared declarations beside the artifacts Paseo loads. The
 * server's own subpaths (./paseo/*, ./panel/*) and shared DTOs get real typed declarations; the
 * ambient alp:templates / alp:plugin-client modules are referenced from the emitted files so a
 * consumer's program resolves them without dummy any declarations.
 */
export async function emitPluginDeclarations() {
  const paseo = path.join(ROOT, 'integrations/paseo');
  const serverDist = path.join(paseo, 'server/dist');
  const ambient = path.join(paseo, 'server/alp-templates.d.ts');
  const roots = [...await walkTypeScript(path.join(paseo, 'server')), ...await walkTypeScript(path.join(paseo, 'shared'))];
  roots.push(ambient);
  const output = path.join(ROOT, '.cache/plugin-declarations');
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, allowJs: true, checkJs: false, skipLibCheck: true, declaration: true, emitDeclarationOnly: true, noEmitOnError: true,
    rootDir: ROOT, outDir: output, customConditions: ['alp-source'], types: ['node'], jsx: ts.JsxEmit.ReactJSX,
  };
  const program = ts.createProgram(roots, options);
  const writes = [];
  const serverPrefix = path.join(output, 'integrations/paseo/server') + path.sep;
  const sharedPrefix = path.join(output, 'integrations/paseo/shared') + path.sep;
  const emit = (text, file) => {
    const destination = path.join(serverDist, file);
    // A server file one level under dist imports ../../shared; the shipped layout is dist/shared.
    const fixed = text.replaceAll("'../../shared/", "'../shared/").replaceAll('"../../shared/', '"../shared/');
    const depth = file.split(path.sep).length - 1;
    const reference = depth > 0 ? `${'../'.repeat(depth)}alp-templates.d.ts` : 'alp-templates.d.ts';
    const body = /["']alp:/.test(fixed) ? `/// <reference path="${reference}" />\n${fixed}` : fixed;
    writes.push((async () => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, body); })());
  };
  const result = program.emit(undefined, (file, content) => {
    if (file.startsWith(serverPrefix)) return emit(content, file.slice(serverPrefix.length));
    if (file.startsWith(sharedPrefix)) return emit(content, path.join('shared', file.slice(sharedPrefix.length)));
  });
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => ROOT, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
  await Promise.all(writes);
  await cp(ambient, path.join(serverDist, 'alp-templates.d.ts'));
}
