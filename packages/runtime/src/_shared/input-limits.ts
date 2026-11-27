/**
 * Size caps for values that reach ALP from a provider or an external MCP server, checked
 * before any schema walks them. Zod before 4.6.6 walks every element of an array before it
 * reports the array's .max(), and a record has no bound at all, so a cap stated only in a
 * schema still costs time and memory in proportion to the input. This walk stops at the first
 * cap the value passes, so its own cost is bounded by the caps, not by the value.
 */
export type InputLimits = {
  /** UTF-8 bytes of the value as JSON, roughly: strings, keys and separators. */
  bytes: number;
  /** Array elements and object keys, counted over the whole value. */
  items: number;
  /** Arrays and objects inside each other; 1 admits a flat list or object of scalars. */
  depth: number;
  /** Characters in any one string, keys included. */
  string: number;
};

/** The arguments of any ALP tool. The longest declared field is alp_delegate's 32,000-character task. */
export const TOOL_INPUT: InputLimits = { bytes: 1024 * 1024, items: 5_000, depth: 8, string: 128 * 1024 };

/** alp_task pour's vars: a flat object of text, one value per variable the formula declares. */
export const POUR_VARS: InputLimits = { bytes: 128 * 1024, items: 50, depth: 1, string: 2_000 };
/** A formula variable's name, as validateFormula admits it. */
export const VAR_NAME = /^[\w-]{1,64}$/;

/** The first cap `value` passes, as an error that names `what`, or undefined within them. */
export function inputLimitError(value: unknown, limits: InputLimits, what = 'The input'): string | undefined {
  let bytes = 0;
  let items = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  const tooLarge = `${what} is too large: over ${limits.bytes} bytes`;
  const text = (string: string) => {
    if (string.length > limits.string) return `${what} is too large: a text over ${limits.string} characters`;
    bytes += Buffer.byteLength(string) + 2;
    return bytes > limits.bytes ? tooLarge : undefined;
  };
  while (stack.length) {
    const [current, depth] = stack.pop()!;
    if (typeof current === 'string') {
      const error = text(current);
      if (error) return error;
    } else if (current !== null && typeof current === 'object') {
      if (depth >= limits.depth) return `${what} is too large: nested over ${limits.depth} levels deep`;
      bytes += 2;
      const list = Array.isArray(current);
      const keys = list ? undefined : Object.keys(current);
      const size = list ? current.length : keys!.length;
      if (items + size > limits.items) return `${what} is too large: over ${limits.items} values`;
      items += size;
      for (let index = 0; index < size; index++) {
        if (keys) {
          const error = text(keys[index]);
          if (error) return error;
        }
        bytes += 1;
        stack.push([list ? current[index] : (current as Record<string, unknown>)[keys![index]], depth + 1]);
      }
    } else {
      bytes += String(current).length;
    }
    if (bytes > limits.bytes) return tooLarge;
  }
  return undefined;
}
