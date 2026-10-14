import ts from 'typescript';

// A real Paseo import: the SDK scope or a path into the plugin's built output.
const PASEO_IMPORT = /^@getpaseo(\/|$)|integrations\/paseo\/server\/dist(\/|$)/;
// A string that names the plugin's built output, however it is used (a spawn path, for example).
const PASEO_PATH = /integrations\/paseo\/server\/dist(\/|$)/;

/**
 * The Paseo plugin or SDK references a module actually makes. This walks the TypeScript AST so that
 * a specifier mentioned inside a string fixture is not mistaken for a real dependency: `@getpaseo`
 * only counts as an import or require, while a string only counts when it points into the plugin's
 * own `server/dist`, which is how a test would silently spawn the plugin it must not depend on.
 */
export function paseoImportSpecifiers(source, fileName = 'module.js') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const imported = [];
  const add = node => { if (node && ts.isStringLiteral(node)) imported.push(node.text); };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const strings = [];
  const collect = node => { if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text); ts.forEachChild(node, collect); };
  collect(file);
  return [...new Set([...imported.filter(text => PASEO_IMPORT.test(text)), ...strings.filter(text => PASEO_PATH.test(text))])];
}

/** Repository location of each workspace, as named in file paths. */
const WORKSPACE_PATHS = [['packages/', ['protocol', 'core', 'runtime', 'client', 'daemon', 'cli']], ['integrations/', ['paseo']], ['apps/', ['tui']]];

/** The workspaces whose files a string literal points into (`packages/x/...`, `integrations/paseo/...`, `apps/tui/...` or `../../x/...` from a package's tests). */
export function referencedPackages(source, fileName = 'module.js') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const found = new Set();
  const collect = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const [prefix, names] of WORKSPACE_PATHS) {
        for (const match of node.text.matchAll(new RegExp(`${prefix}(${names.join('|')})/`, 'g'))) found.add(match[1]);
      }
      for (const match of node.text.matchAll(/\.\.\/\.\.\/(protocol|core|runtime|client|daemon|cli|paseo|tui)\//g)) found.add(match[1]);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  return [...found];
}
