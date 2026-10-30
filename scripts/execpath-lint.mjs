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
  // import { execPath } from 'node:process' (or 'process').
  if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'execPath') {
    const declaration = node.parent?.parent?.parent;
    return Boolean(declaration && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) && /^(node:)?process$/.test(declaration.moduleSpecifier.text));
  }
  return false;
}
