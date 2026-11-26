// The normative v1 contract (schema/methods-v1.json) as data, with checks over it.
// No Node or runtime imports: daemons, clients and conformance runners share it.
import { METHODS_V1 } from './contract-v1.ts';
import { validateSchema, type SchemaIssue } from './validate.ts';

export { METHODS_V1, validateSchema };

/** Capabilities a v1 daemon may list in its daemon.hello result; the schema documents each. */
export const CAPABILITIES: readonly string[] = Object.freeze(Object.keys(METHODS_V1.capabilities));

// any: a method entry's params/result are JSON Schema documents handed to validateSchema.
const methodOf = (method: string): any => Object.hasOwn(METHODS_V1.methods, method) ? (METHODS_V1.methods as Record<string, any>)[method] : undefined;

/**
 * Checks the params of a v1 method. Absent params count as `{}`.
 * @returns undefined for a method v1 does not define
 */
export function validateParams(method: string, params: unknown): SchemaIssue[] | undefined {
  const entry = methodOf(method);
  return entry && validateSchema(entry.params, params === undefined ? {} : params, METHODS_V1);
}

/**
 * Checks the result of a v1 method.
 * @returns undefined for a method v1 does not define
 */
export function validateResult(method: string, result: unknown): SchemaIssue[] | undefined {
  const entry = methodOf(method);
  return entry && validateSchema(entry.result, result, METHODS_V1);
}

/**
 * Checks one shared definition, such as `envelope`, `error` or `request`.
 */
export function validateDefinition(name: string, value: unknown): SchemaIssue[] {
  if (!Object.hasOwn(METHODS_V1.$defs, name)) throw new Error(`No definition ${name}`);
  return validateSchema({ $ref: `#/$defs/${name}` }, value, METHODS_V1);
}
