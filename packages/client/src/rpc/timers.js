/** The longest delay setTimeout honours; a longer one fires at once, in browsers, Node and Hermes. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * A timeout option as a setTimeout delay. `undefined` means no timer: no timeout given, Infinity,
 * or a wait longer than any timer can (about 24.8 days). Anything that is not a non-negative
 * number is a TypeError, so a typo cannot turn into an instant timeout.
 * @param {unknown} value
 * @param {string} [name]
 * @returns {number | undefined}
 */
export function timerDelay(value, name = 'timeoutMs') {
  if (value === undefined || value === Infinity) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) throw new TypeError(`${name} must be a non-negative number of milliseconds`);
  return value > MAX_TIMER_MS ? undefined : value;
}
