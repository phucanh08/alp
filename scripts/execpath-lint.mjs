// The process.execPath rule of check-boundaries.mjs (t-1e02), separate so it can be tested.
import ts from 'typescript';

/** Whether `node` reads process.execPath: process.execPath, process['execPath'], or `{ execPath } = process`. */
export function namesExecPath(node) {
  const isProcess = expression => (ts.isIdentifier(expression) && expression.text === 'process')
    || (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'globalThis' && expression.name.text === 'process');
  if (ts.isPropertyAccessExpression(node) && isProcess(node.expression) && node.name.text === 'execPath') return true;
  if (ts.isElementAccessExpression(node) && isProcess(node.expression) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'execPath') return true;
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer && isProcess(node.parent.parent.initializer)) {
    const key = node.propertyName ?? node.name;
    return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'execPath';
  }
  // import * as p from 'node:process'; p.execPath
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'execPath' && ts.isIdentifier(node.expression) && processNamespaces(node.getSourceFile()).has(node.expression.text)) return true;
  // import { execPath } from 'node:process' (or 'process').
  if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'execPath') {
    const declaration = node.parent?.parent?.parent;
    return Boolean(declaration && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) && /^(node:)?process$/.test(declaration.moduleSpecifier.text));
  }
  return false;
}

const namespaces = new WeakMap();
/** Names bound by `import * as x from 'node:process'` (or 'process') in `source`. */
function processNamespaces(source) {
  let names = namespaces.get(source);
  if (names) return names;
  names = new Set();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && /^(node:)?process$/.test(statement.moduleSpecifier.text) ? statement.importClause?.namedBindings ?? statement.importClause?.name : undefined;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (statement.importClause?.name && ts.isImportDeclaration(statement) && /^(node:)?process$/.test(/** @type {any} */ (statement.moduleSpecifier).text)) names.add(statement.importClause.name.text);
  }
  namespaces.set(source, names);
  return names;
}
