// The normative v1 contract (schema/methods-v1.json) as data, with checks over it.
// Pure JavaScript with no Node or runtime imports: daemons, clients and conformance runners share it.
import { METHODS_V1 } from './contract-v1.js';
import { validateSchema } from './validate.js';

export { METHODS_V1, validateSchema };

/** Capabilities a v1 daemon may list in its daemon.hello result; the schema documents each. */
export const CAPABILITIES = Object.freeze(Object.keys(METHODS_V1.capabilities));

/** @param {string} method */
const methodOf = method => Object.hasOwn(METHODS_V1.methods, method) ? /** @type {any} */ (METHODS_V1.methods)[method] : undefined;

/**
 * Checks the params of a v1 method. Absent params count as `{}`.
 * @param {string} method
 * @param {unknown} params
 * @returns {import('./validate.js').SchemaIssue[] | undefined} undefined for a method v1 does not define
 */
export function validateParams(method, params) {
  const entry = methodOf(method);
  return entry && validateSchema(entry.params, params === undefined ? {} : params, METHODS_V1);
}

/**
 * Checks the result of a v1 method.
 * @param {string} method
 * @param {unknown} result
 * @returns {import('./validate.js').SchemaIssue[] | undefined} undefined for a method v1 does not define
 */
export function validateResult(method, result) {
  const entry = methodOf(method);
  return entry && validateSchema(entry.result, result, METHODS_V1);
}

/**
 * Checks one shared definition, such as `envelope`, `error` or `request`.
 * @param {string} name
 * @param {unknown} value
 */
export function validateDefinition(name, value) {
  if (!Object.hasOwn(METHODS_V1.$defs, name)) throw new Error(`No definition ${name}`);
  return validateSchema({ $ref: `#/$defs/${name}` }, value, METHODS_V1);
}
