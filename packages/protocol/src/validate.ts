/**
 * A dependency-free checker for the JSON Schema subset the protocol schemas use (draft-07:
 * type, const, enum, properties, required, additionalProperties, items, minItems, maxItems, minimum, maximum,
 * minLength, maxLength, pattern, oneOf, anyOf, not and local `#/$defs/...` references).
 * Lengths count Unicode code points, as JSON Schema does. A property whose value is
 * `undefined` counts as absent, so in-process callers behave as their JSON would.
 */

export type SchemaIssue = { path: string; message: string };

const MAX_ISSUES = 8;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return !Number.isFinite(value) ? 'non-finite number' : Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const typeMatches = (want: string, have: string) => want === have || (want === 'number' && have === 'integer');

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b) || a === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, index) => equal(item, (b as unknown[])[index]));
  const left = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined);
  const right = Object.keys(b as object).filter(key => (b as Record<string, unknown>)[key] !== undefined);
  return left.length === right.length && left.every(key => equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

// any: a JSON Schema document walked by keys only known at run time.
function resolve(root: any, ref: string): any {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported schema reference ${ref}`);
  let target = root;
  for (const part of ref.slice(2).split('/')) target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  if (target === undefined) throw new Error(`Unresolved schema reference ${ref}`);
  return target;
}

// any: `schema` and `root` are JSON Schema documents whose keywords are read dynamically.
function check(schema: any, value: unknown, at: string, root: any, issues: SchemaIssue[]): void {
  if (issues.length >= MAX_ISSUES || schema === true || schema === undefined) return;
  if (schema === false) { issues.push({ path: at, message: 'is not allowed' }); return; }
  if (schema.$ref) { check(resolve(root, schema.$ref), value, at, root, issues); if (Object.keys(schema).length === 1) return; }
  const kind = typeOf(value);
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((want: string) => typeMatches(want, kind))) { issues.push({ path: at, message: `must be ${wanted.join(' or ')}` }); return; }
  }
  if ('const' in schema && !equal(schema.const, value)) { issues.push({ path: at, message: `must be ${JSON.stringify(schema.const)}` }); return; }
  if (schema.enum && !schema.enum.some((option: unknown) => equal(option, value))) { issues.push({ path: at, message: `must be one of ${schema.enum.map((option: unknown) => JSON.stringify(option)).join(', ')}` }); return; }
  if (kind === 'integer' || kind === 'number') {
    const number = value as number;
    if (schema.minimum !== undefined && number < schema.minimum) issues.push({ path: at, message: `must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && number > schema.maximum) issues.push({ path: at, message: `must be at most ${schema.maximum}` });
  }
  if (kind === 'string') {
    const text = value as string;
    let length = 0;
    if (schema.minLength !== undefined || schema.maxLength !== undefined) for (const _point of text) length++;
    if (schema.minLength !== undefined && length < schema.minLength) issues.push({ path: at, message: `must have at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push({ path: at, message: `must have at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(text)) issues.push({ path: at, message: `must match ${schema.pattern}` });
  }
  if (kind === 'array' && schema.minItems !== undefined && (value as unknown[]).length < schema.minItems) issues.push({ path: at, message: `must have at least ${schema.minItems} items` });
  if (kind === 'array' && schema.maxItems !== undefined && (value as unknown[]).length > schema.maxItems) issues.push({ path: at, message: `must have at most ${schema.maxItems} items` });
  if (kind === 'array' && schema.items !== undefined) {
    const array = value as unknown[];
    for (let index = 0; index < array.length && issues.length < MAX_ISSUES; index++) check(schema.items, array[index] === undefined ? null : array[index], `${at}/${index}`, root, issues);
  }
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) if (object[name] === undefined) issues.push({ path: `${at}/${name}`, message: 'is required' });
    for (const [name, child] of Object.entries(object)) {
      if (child === undefined) continue;
      if (Object.hasOwn(properties, name)) check(properties[name], child, `${at}/${name}`, root, issues);
      else if (schema.additionalProperties !== undefined) check(schema.additionalProperties, child, `${at}/${name}`, root, issues);
    }
  }
  if (schema.not !== undefined) {
    const inner: SchemaIssue[] = [];
    check(schema.not, value, at, root, inner);
    if (!inner.length) issues.push({ path: at, message: 'matches a schema it must not match' });
  }
  for (const [keyword, exactlyOne] of [['anyOf', false], ['oneOf', true]] as const) {
    if (!schema[keyword]) continue;
    const passing = schema[keyword].filter((option: unknown) => { const inner: SchemaIssue[] = []; check(option, value, at, root, inner); return !inner.length; }).length;
    if (exactlyOne ? passing !== 1 : passing === 0) issues.push({ path: at, message: exactlyOne && passing > 1 ? 'matches more than one allowed shape' : 'matches none of the allowed shapes' });
  }
}

/**
 * Checks `value` against `schema`, resolving `#/$defs/...` against `root`.
 * @returns empty when the value conforms
 */
// any: callers pass arbitrary JSON Schema documents (the v1 contract or their own).
export function validateSchema(schema: any, value: unknown, root: any = schema): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, value, '', root, issues);
  return issues;
}
