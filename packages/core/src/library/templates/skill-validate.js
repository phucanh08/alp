import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Skill validation (Agent Skills format, https://agentskills.io/specification): a skill is a
 * directory holding SKILL.md, whose YAML frontmatter names it and says what it is for, and the
 * references, scripts and assets SKILL.md points to.
 *
 * Two modes. `strict` is for skills ALP ships, packs and new skills: format problems are errors.
 * `legacy` (the default) is for skills already in a user's library or project: format problems
 * are warnings with a migration hint, since ALP never rewrites them and the runtime keeps loading
 * them. A symlink leaving the skill, a broken symlink or an unreadable file is an error in both
 * modes; a plain path leaving the skill is an error in strict mode and a warning in legacy mode. Validation only reads; it never runs a script or follows a link outside the skill.
 */

/** Frontmatter keys of the Agent Skills specification. */
export const SPEC_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
/** Keys other runtimes add (Claude Code); kept, reported as runtime-specific in strict mode. */
const RUNTIME_KEYS = ['argument-hint', 'disable-model-invocation', 'user-invocable', 'model', 'version', 'when_to_use', 'mode'];
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
/** How much of a description ALP's skill index shows (resolve.ts SKILL_DESCRIPTION_CHARS). */
export const INDEX_DESCRIPTION_CHARS = 400;
const COMPATIBILITY_MAX = 500;
const BODY_LINES_RECOMMENDED = 500;
const MAX_FILES = 2000;


const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A trigger cue: the description says when to use the skill. */
const TRIGGER_RE = /\b(use|when|before|after|whenever|for)\b|dùng|khi/i;

/** Whether `name` follows the specification's name rules. */
export const specName = name => typeof name === 'string' && name.length >= 1 && name.length <= NAME_MAX && NAME_RE.test(name);

/** A YAML double-quoted scalar's escapes (the JSON subset plus \/ and \e not needed here). */
function doubleQuoted(raw) {
  try { return JSON.parse(`"${raw.replace(/\\'/g, "'")}"`); } catch { return undefined; }
}

/**
 * Parses the YAML subset skills use: `key: scalar`, quoted scalars, block scalars (`|`, `>`),
 * multi-line plain scalars, comments, and one level of `key:` + indented `sub: value` (metadata).
 * Anything else (sequences, flow collections, anchors, tags) is reported as unsupported.
 * @returns {{ data: Record<string, unknown>, problems: string[] }}
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  const data = {};
  const problems = [];
  const indent = line => /^ */.exec(line)[0].length;
  let i = 0;
  const scalar = (raw, key, baseIndent) => {
    const value = raw.trim();
    if (!value) {
      // A nested mapping, or an empty value.
      const nested = {};
      let found = false;
      while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#') || indent(lines[i]) > baseIndent)) {
        const line = lines[i++];
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const match = /^\s+([^:#\s][^:]*?):(?:\s+(.*)|\s*)$/.exec(line);
        if (!match) { problems.push(`${key}: unsupported YAML in '${line.trim()}' (use "key: value" lines)`); continue; }
        found = true;
        nested[match[1].trim()] = scalar(match[2] ?? '', `${key}.${match[1].trim()}`, indent(line));
      }
      return found ? nested : '';
    }
    if (value.startsWith('"')) {
      const end = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
      if (!end) { problems.push(`${key}: unterminated or multi-line double-quoted value`); return undefined; }
      const parsed = doubleQuoted(end[1]);
      if (parsed === undefined) problems.push(`${key}: invalid escape in double-quoted value`);
      return parsed;
    }
    if (value.startsWith("'")) {
      const end = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
      if (!end) { problems.push(`${key}: unterminated or multi-line single-quoted value`); return undefined; }
      return end[1].replaceAll("''", "'");
    }
    const block = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(?:#.*)?$/.exec(value);
    if (block?.[3]) problems.push(`${key}: block scalar indentation indicators are not supported; indent the text instead`);
    if (block) {
      const body = [];
      while (i < lines.length && (lines[i].trim() === '' || indent(lines[i]) > baseIndent)) body.push(lines[i++]);
      while (body.length && !body[body.length - 1].trim()) body.pop();
      const width = Math.min(...body.filter(line => line.trim()).map(indent));
      const content = body.map(line => line.slice(Number.isFinite(width) ? width : 0));
      const joined = block[1] === '|' ? content.join('\n') : content.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
      return (block[2] || block[4]) === '-' ? joined : `${joined}\n`;
    }
    if (/^[[{&*!%@`]/.test(value) || value.startsWith('- ')) {
      problems.push(`${key}: unsupported YAML value '${value.slice(0, 40)}' (use a plain or quoted string)`);
      return undefined;
    }
    let plain = value.replace(/\s+#.*$/, '');
    // A plain scalar may continue on more-indented lines.
    while (i < lines.length && lines[i].trim() && indent(lines[i]) > baseIndent && !lines[i].trimStart().startsWith('#')) plain += ` ${lines[i++].trim()}`;
    if (/:\s/.test(plain) || plain.endsWith(':')) problems.push(`${key}: plain value contains ": " which YAML rejects; quote the value`);
    return plain;
  };
  while (i < lines.length) {
    const line = lines[i++];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indent(line) > 0) { problems.push(`unexpected indentation: '${line.trim().slice(0, 40)}'`); continue; }
    const match = /^([^:#\s][^:]*?):(?:\s+(.*)|\s*)$/.exec(line);
    if (!match) { problems.push(`not a "key: value" line: '${line.trim().slice(0, 40)}'`); continue; }
    const key = match[1].trim();
    if (Object.hasOwn(data, key)) problems.push(`${key}: duplicate key`);
    data[key] = scalar(match[2] ?? '', key, 0);
  }
  return { data, problems };
}

/** The frontmatter block and body of a SKILL.md, or undefined frontmatter when it has none. */
export function splitSkill(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? { frontmatter: match[1], body: text.slice(match[0].length) } : { frontmatter: undefined, body: text };
}

/**
 * The relative files a Markdown text points to: link targets and code spans naming a resource
 * directory (`references/x.md`). URLs, anchors and template placeholders are skipped.
 */
export function skillReferences(markdown) {
  const found = new Set();
  const withoutFences = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  for (const match of withoutFences.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) found.add(match[1]);
  // A code span is a reference only under references/: `scripts/x` or `templates/` in prose often
  // names a directory of the project the skill works on, so those need a link to be checked.
  for (const match of withoutFences.matchAll(/`([^`\s]+)`/g)) {
    if (/^(?:\.\/)?references\/[^*<>{}$]+\.[a-z0-9]+$/i.test(match[1])) found.add(match[1]);
  }
  return [...found].filter(target => !/^[a-z][\w+.-]*:/i.test(target) && !target.startsWith('#') && !target.startsWith('//'))
    .map(target => { const plain = target.split('#')[0]; try { return decodeURI(plain); } catch { return plain; } }).filter(Boolean);
}

const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

/**
 * Checks frontmatter text against the specification. `directory` is the skill directory's name.
 * @returns {{ data: Record<string, unknown>, findings: Array<{ level: 'error' | 'warning', code: string, message: string }> }}
 */
export function checkFrontmatter(frontmatter, directory, { strict = false } = {}) {
  const findings = [];
  const format = (code, message) => findings.push({ level: strict ? 'error' : 'warning', code, message });
  const error = (code, message) => findings.push({ level: 'error', code, message });
  const warn = (code, message) => findings.push({ level: 'warning', code, message });
  if (frontmatter === undefined) {
    format('NO_FRONTMATTER', 'SKILL.md has no YAML frontmatter; add "---\\nname: ...\\ndescription: ...\\n---" so agents see what the skill is for');
    return { data: {}, findings };
  }
  const { data, problems } = parseFrontmatter(frontmatter);
  for (const problem of problems) format('YAML', `frontmatter: ${problem}`);
  const { name, description } = data;
  if (name === undefined) format('NAME_MISSING', 'frontmatter has no name');
  else if (typeof name !== 'string' || !specName(name)) format('NAME_FORMAT', `name '${name}' must be 1-${NAME_MAX} lowercase letters, digits and single hyphens, not starting or ending with one`);
  if (typeof name === 'string' && directory !== undefined && name !== directory) format('NAME_DIRECTORY', `name '${name}' differs from its directory '${directory}'; agents find it by the directory name`);
  if (directory !== undefined && !specName(directory)) format('DIRECTORY_NAME', `directory '${directory}' is not a valid skill name; rename it to lowercase letters, digits and hyphens`);
  if (description === undefined || (typeof description === 'string' && !description.trim())) format('DESCRIPTION_MISSING', 'frontmatter has no description: it is all an agent sees before opening the skill');
  else if (typeof description !== 'string') format('DESCRIPTION_FORMAT', 'description must be text');
  else {
    const flat = description.replace(/\s+/g, ' ').trim();
    if (flat.length > DESCRIPTION_MAX) format('DESCRIPTION_LENGTH', `description has ${flat.length} characters; the limit is ${DESCRIPTION_MAX}`);
    else if (flat.length > INDEX_DESCRIPTION_CHARS) warn('DESCRIPTION_CLIPPED', `description has ${flat.length} characters; ALP's skill index shows the first ${INDEX_DESCRIPTION_CHARS}`);
    if (flat.length < 40) warn('DESCRIPTION_SHORT', 'description is under 40 characters; say what the skill does and when to use it');
    if (!TRIGGER_RE.test(flat)) warn('DESCRIPTION_TRIGGER', 'description does not say when to use the skill (for example "Use when ...")');
    if (/[<>]/.test(flat)) format('DESCRIPTION_ANGLE', 'description contains < or >, which some runtimes reject');
  }
  if (data.compatibility !== undefined && (typeof data.compatibility !== 'string' || data.compatibility.length > COMPATIBILITY_MAX)) format('COMPATIBILITY', `compatibility must be text of at most ${COMPATIBILITY_MAX} characters`);
  if (data.license !== undefined && typeof data.license !== 'string') format('LICENSE', 'license must be text');
  if (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') format('ALLOWED_TOOLS', 'allowed-tools must be a space-separated string');
  if (data['allowed-tools'] !== undefined) warn('ALLOWED_TOOLS_ADVISORY', 'allowed-tools is advisory: ALP permissions come from the session mode and permission profiles, never from a skill');
  if (data.metadata !== undefined && (typeof data.metadata !== 'object' || data.metadata === null || Object.values(data.metadata).some(value => typeof value !== 'string'))) format('METADATA', 'metadata must map names to text values');
  for (const key of Object.keys(data)) {
    if (SPEC_KEYS.includes(key)) continue;
    if (RUNTIME_KEYS.includes(key)) format('RUNTIME_KEY', `'${key}' is specific to one runtime; other runtimes ignore it`);
    else format('UNKNOWN_KEY', `unknown frontmatter key '${key}'; the specification allows ${SPEC_KEYS.join(', ')}`);
  }
  return { data, findings };
}

/** Whether a buffer is UTF-8 text without NUL bytes. */
const isText = buffer => !buffer.includes(0) && Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);

/**
 * Validates one skill directory.
 * @param {string} directory absolute or relative path of the skill directory
 * @param {{ mode?: 'strict' | 'legacy', shipped?: boolean }} [options] `shipped`: the skill ships in
 *   ALP's templates, which bundles carry as UTF-8 text, so every file must be text
 * @returns {Promise<{ name: string, directory: string, mode: 'strict' | 'legacy', ok: boolean, errors: Finding[], warnings: Finding[], files: number }>}
 * @typedef {{ code: string, message: string, file?: string }} Finding
 */
export async function validateSkill(directory, { mode = 'legacy', shipped = false } = {}) {
  const root = path.resolve(directory);
  const strict = mode === 'strict';
  /** @type {Array<Finding & { level: 'error' | 'warning' }>} */
  const findings = [];
  const add = (level, code, message, file) => findings.push({ level, code, message, ...(file ? { file } : {}) });
  const format = (code, message, file) => add(strict ? 'error' : 'warning', code, message, file);
  const result = () => {
    const errors = findings.filter(f => f.level === 'error').map(({ level, ...f }) => f);
    const warnings = findings.filter(f => f.level === 'warning').map(({ level, ...f }) => f);
    return { name: path.basename(root), directory: root, mode, ok: errors.length === 0, errors, warnings, files };
  };
  let files = 0;
  const info = await lstat(root).catch(() => undefined);
  if (!info) { add('error', 'NOT_FOUND', `no skill directory at ${root}`); return result(); }
  if (info.isSymbolicLink()) add('warning', 'DIRECTORY_LINK', 'the skill directory is a symbolic link; its contents are checked where it points');
  const real = await realpath(root).catch(() => root);
  if (!(await stat(real).then(s => s.isDirectory(), () => false))) { add('error', 'NOT_DIRECTORY', `${root} is not a directory`); return result(); }

  // Every file under the skill: symlinks must stay inside it; shipped skills must be text.
  const markdown = [];
  let stopped = false;
  const walk = async relative => {
    let entries;
    try { entries = await readdir(path.join(real, relative), { withFileTypes: true }); }
    catch (error) { add('error', 'UNREADABLE', `${relative || '.'} cannot be read: ${error.code ?? error.message}`, relative || undefined); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      const rel = path.join(relative, entry.name);
      const full = path.join(real, rel);
      if (++files > MAX_FILES) { stopped = true; add('error', 'TOO_MANY_FILES', `more than ${MAX_FILES} files; a skill should hold instructions and small resources`); return; }
      if (entry.name === 'node_modules' || entry.name === '.git') { add('warning', 'BUNDLED_DEPENDENCIES', `${rel} is bundled; skills must not carry installed dependencies or repositories`, rel); continue; }
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => undefined);
        if (target === undefined) add('error', 'BROKEN_SYMLINK', `${rel} is a symbolic link to nothing`, rel);
        else if (!inside(real, target)) add('error', 'UNSAFE_SYMLINK', `${rel} links outside the skill (${target})`, rel);
        else if (shipped) add('error', 'SHIPPED_SYMLINK', `${rel} is a symbolic link; shipped skills hold plain files`, rel);
        continue;
      }
      if (entry.isDirectory()) { await walk(rel); continue; }
      if (!entry.isFile()) { add('error', 'SPECIAL_FILE', `${rel} is not a regular file`, rel); continue; }
      const posix = rel.split(path.sep).join('/');
      if (shipped || posix.endsWith('.md') || posix.startsWith('scripts/')) {
        let buffer;
        try { buffer = await readFile(full); }
        catch (error) { add('error', 'UNREADABLE', `${rel} cannot be read: ${error.code ?? error.message}`, rel); continue; }
        if (shipped && !isText(buffer)) add('error', 'SHIPPED_BINARY', `${rel} is not UTF-8 text; ALP bundles carry shipped skills as text`, rel);
        if (posix.endsWith('.md')) markdown.push([posix, buffer.toString('utf8')]);
        if (posix.startsWith('scripts/') && !shipped && process.platform !== 'win32' && buffer.subarray(0, 2).toString() === '#!' && !((await stat(full)).mode & 0o111)) {
          add('warning', 'SCRIPT_NOT_EXECUTABLE', `${rel} has a #! line but is not executable; run it with its interpreter or chmod +x it`, rel);
        }
      }
    }
  };
  await walk('');

  const skillFile = markdown.find(([file]) => file === 'SKILL.md');
  if (!skillFile) {
    const other = await readdir(real).then(list => list.find(name => name.toLowerCase() === 'skill.md'), () => undefined);
    add('error', 'SKILL_MD_MISSING', other ? `found ${other}; the file must be named SKILL.md` : 'no SKILL.md');
    return result();
  }
  const { frontmatter, body } = splitSkill(skillFile[1]);
  for (const finding of checkFrontmatter(frontmatter, path.basename(root), { strict }).findings) add(finding.level, finding.code, finding.message, 'SKILL.md');
  if (!body.trim()) format('BODY_EMPTY', 'SKILL.md has no instructions after its frontmatter', 'SKILL.md');
  const lines = body.split('\n').length;
  if (lines > BODY_LINES_RECOMMENDED) add('warning', 'BODY_LONG', `SKILL.md body has ${lines} lines; move detail into references/ (recommended under ${BODY_LINES_RECOMMENDED})`, 'SKILL.md');

  // References from every Markdown file in the skill, resolved against that file.
  for (const [file, text] of markdown) {
    const content = file === 'SKILL.md' ? body : text;
    for (const target of skillReferences(content)) {
      // A path leaving the skill does not travel with it: an error for new skills, a warning for existing
      // ones (a link to a sibling skill still works where it is). A symlink leaving it is always an error.
      if (path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target) || target.startsWith('~')) { format('ABSOLUTE_REFERENCE', `${file} names the absolute path ${target}; use a path relative to the skill`, file); continue; }
      const resolved = path.resolve(real, path.dirname(file), target);
      if (!inside(real, resolved)) { format('REFERENCE_OUTSIDE', `${file} points outside the skill: ${target}`, file); continue; }
      const linked = await lstat(resolved).catch(() => undefined);
      if (!linked) { format('BROKEN_REFERENCE', `${file} points to ${target}, which does not exist`, file); continue; }
      if (linked.isSymbolicLink()) {
        const target2 = await realpath(resolved).catch(() => undefined);
        if (!target2 || !inside(real, target2)) add('error', 'REFERENCE_OUTSIDE', `${file} points through a link outside the skill: ${target}`, file);
      }
    }
  }
  return result();
}

/** One line per finding, for a terminal. */
export function formatValidation(report) {
  const head = `${report.ok ? 'ok  ' : 'FAIL'} ${report.name} (${report.mode}) ${report.directory}`;
  const rows = [...report.errors.map(f => `  error   ${f.code}: ${f.message}`), ...report.warnings.map(f => `  warning ${f.code}: ${f.message}`)];
  return [head, ...rows].join('\n');
}
