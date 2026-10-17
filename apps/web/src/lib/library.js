// @ts-check
/**
 * What the Settings library pages show of one entry's content (library.get through the gateway,
 * docs/alp/remote-gateway.md §5.4). The gateway answers `{ $secret: 'keep' }` in place of every
 * value that can hold a secret; those show as HIDDEN, never as the marker or a guess.
 */

/** What a hidden value shows as. */
export const HIDDEN = '‹hidden on the host›';

/** Text fields of each kind, shown as they are written (Markdown files). */
const TEXT_FIELDS = new Set(['instructions', 'body', 'houseRules']);

/** Labels of each kind's content fields, as the files on the host are named. */
const LABELS = /** @type {Record<string, string>} */ ({
  instructions: 'AGENT.md', config: 'agent.json', body: 'SKILL.md', server: 'Server', hook: 'Hook', team: 'team.json', houseRules: 'HOUSE_RULES.md', provider: 'Provider',
});

/** @param {unknown} value */
export const isSecretMarker = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && /** @type {Record<string, unknown>} */ (value).$secret === 'keep';

/**
 * The parts of an entry's content in display order: Markdown files as text, configuration as
 * indented JSON with hidden values replaced by HIDDEN.
 * @param {Record<string, unknown>} content
 * @returns {Array<{ key: string, label: string, kind: 'text' | 'json', text: string }>}
 */
export function libraryContentParts(content) {
  const parts = [];
  for (const [key, value] of Object.entries(content ?? {})) {
    const label = LABELS[key] ?? key;
    if (TEXT_FIELDS.has(key) && typeof value === 'string') { parts.push({ key, label, kind: /** @type {const} */ ('text'), text: value }); continue; }
    if (value === undefined) continue;
    const text = isSecretMarker(value) ? HIDDEN : JSON.stringify(value, (_, item) => isSecretMarker(item) ? HIDDEN : item, 2);
    parts.push({ key, label, kind: /** @type {const} */ ('json'), text });
  }
  return parts;
}
