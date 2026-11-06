// Read what templates/ actually says, so a test does not keep its own copy of a sentence (t-814a).
//
// The t-9043 translation reworded templates/ and broke assertions in eleven test files, none of
// which were about the wording: they only needed "these instructions came from THIS template" or
// "the skill index shows the skill's description". A copied sentence makes every rewording a test
// failure, and — worse — makes a `doesNotMatch` silently vacuous the moment the sentence it names
// stops existing (test/integration/acp.test.js had exactly that).
//
// So: anchor on STRUCTURE (a file's title, a frontmatter field, the one line that mentions a value)
// and read the text at that anchor from the template at run time. A reworded template then changes
// nothing except where the test is deliberately about the words.
//
// Every reader below THROWS when its anchor is missing or ambiguous, so a renamed template or a
// moved line is a loud failure and never an assertion that passes against an empty string.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Through the PACKAGE, never a relative path into packages/core: scripts/tarball-consumer.mjs copies
// test/support modules into an isolated consumer project where only the published packages exist, and
// a relative import would die there with ERR_MODULE_NOT_FOUND (group C's lesson, board p-dd50ae3b).
// `@anhlp/alp-core` ships `templates/`, so this resolves in the repository and in a consumer alike.
import { shippedTemplateRoot } from '@anhlp/alp-core/template-path';

// The SHIPPED template root, the one the runtime hands to an agent — packages/core/templates in this
// repository, which the build copies from templates/. Reading templates/ instead would make these
// tests disagree with the runtime whenever the source has moved ahead of the build, which is a state
// this repository is routinely in (board p-a5af690e), and would report it as a product failure.
const TEMPLATES = path.resolve(fileURLToPath(shippedTemplateRoot()));

/** The text of `<shipped template root>/<relative>`. @param {string} relative */
export function templateText(relative) {
  const file = path.join(TEMPLATES, relative);
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`no template at ${relative} (${error.code}) under ${TEMPLATES}; a test anchored on it must be updated, not deleted`); }
  if (!text.trim()) throw new Error(`${relative} is empty`);
  return text;
}

/** A template's first-level title, without the leading `# `: "Peer — người đóng góp...". */
export function templateTitle(relative) {
  const title = templateText(relative).match(/^#\s+(.+?)\s*$/m)?.[1];
  if (!title) throw new Error(`${relative} has no '# ' title to anchor on`);
  return title;
}

/**
 * A SKILL.md's frontmatter `description`, raw. For comparing against what an agent was GIVEN use
 * `templateIndexDescription`, which applies the runtime's own rule instead of a second copy of it.
 */
export function templateDescription(relative) {
  const frontmatter = templateText(relative).match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) throw new Error(`${relative} has no frontmatter`);
  const description = frontmatter[1].match(/^description:\s*(.+?)\s*$/m)?.[1];
  if (!description) throw new Error(`${relative} has no frontmatter description`);
  return description.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
}

/**
 * The ONE line of a template that contains `needle`, trimmed of list and indent markers. Throws on
 * zero lines (the anchor is gone) and on more than one (the anchor is ambiguous), so neither
 * degrades into a passing assertion.
 * @param {string} relative @param {string} needle
 */
export function templateLineWith(relative, needle) {
  const lines = templateText(relative).split('\n').filter(line => line.includes(needle));
  if (!lines.length) throw new Error(`no line of ${relative} contains ${JSON.stringify(needle)}`);
  if (lines.length > 1) throw new Error(`${lines.length} lines of ${relative} contain ${JSON.stringify(needle)}; anchor on something that appears once:\n${lines.join('\n')}`);
  return lines[0].replace(/^[\s>]*(?:[-*]|\d+\.)?\s*/, '').trim();
}

/**
 * A sentence that is in a SKILL.md's BODY and NOT in its frontmatter description: what must NOT
 * reach an agent that was given only the skill index. Reading it from the template is the whole
 * point — a `doesNotMatch` against a copied sentence passes for free once the copy goes stale.
 */
export function templateBodySentence(relative) {
  const text = templateText(relative);
  const description = templateDescription(relative);
  const body = text.slice(text.indexOf('\n---', 3) + 4);
  const candidate = body.split('\n')
    .map(line => line.replace(/^[\s>]*(?:[-*]|\d+\.)?\s*/, '').replace(/\*\*/g, '').trim())
    // Long enough to be a sentence, not a heading, and genuinely absent from the description.
    .find(line => line.length >= 40 && !line.startsWith('#') && !line.startsWith('`') && !description.includes(line));
  if (!candidate) throw new Error(`${relative} has no body sentence outside its description to anchor on`);
  return candidate;
}

/**
 * The description ALP's skill index carries for `templates/<relative>` — computed by the runtime's
 * OWN `skillDescription`, not by a copy of its rule here: it flattens the frontmatter to one line
 * and truncates past 400 characters with an ellipsis, and a second implementation of that would be
 * one more place to drift (t-ffe4.6 was four such places for tar).
 * @param {string} relative
 */
export async function templateIndexDescription(relative) {
  const { skillDescription } = await import('@anhlp/alp-runtime');
  const description = await skillDescription(path.join(TEMPLATES, relative));
  if (!description) throw new Error(`${relative} has no description the skill index would show`);
  return description;
}

/**
 * The top-level `- ` items of the section under `## <heading>`, each with its continuation lines
 * joined and its whitespace flattened. Asserting on the whole list, read from the template, is what
 * makes a test about "this section reached the agent" instead of about one sentence's wording.
 * Throws when the heading is gone or the section has no bullets.
 * @param {string} relative @param {string} heading
 */
export function templateBullets(relative, heading) {
  const text = templateText(relative);
  const at = text.indexOf(`## ${heading}`);
  if (at < 0) throw new Error(`${relative} has no '## ${heading}' section to anchor on`);
  const section = text.slice(at).split(/\n## /)[0];
  const bullets = [];
  for (const line of section.split('\n').slice(1)) {
    if (/^[-*] /.test(line)) bullets.push(line.replace(/^[-*] /, ''));
    else if (/^\s+\S/.test(line) && bullets.length) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  if (!bullets.length) throw new Error(`${relative}: '## ${heading}' has no top-level bullets`);
  return bullets.map(flatten);
}

/** Text with every run of whitespace as one space: compare prose without depending on line wrapping. */
export const flatten = text => text.replace(/\s+/g, ' ').trim();

/** `text` as a RegExp that matches it literally. */
export const literal = (text, flags) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
