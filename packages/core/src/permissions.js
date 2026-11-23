import path from 'node:path';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { moveFile } from './atomic.js';
import { AlpError } from './errors.js';

/**
 * Permission profiles: what an agent may do beyond, or never do within, its
 * base mode. Rules use Claude Code's syntax, `Tool` or `Tool(specifier)`, such as
 * `Bash(npm test:*)` (a command prefix), `Bash(git status)` (one exact command),
 * `Edit(src/**)` or `WebFetch(domain:example.com)`.
 *
 * Profiles and the agents they apply to come from `permissions` in the project's
 * .alp/settings.json and the user's $ALP_HOME/settings.json. A profile defined in
 * both takes its base from the project and the rules of both. An agent's entry in
 * the project wins over the user's. Deny wins over ask, and ask over allow: an ask
 * rule makes ALP ask the user every time. With `beyondMode: "ask"`, what the mode
 * refuses and no rule covers is asked too, and the user may allow it always.
 *
 * ALP enforces rules natively where it can: Claude receives deny rules, and allow
 * rules for tools other than Bash, as its own disallowed and allowed tools, which hold
 * in every permission mode; Bash allow rules it would match as written, so ALP decides
 * them in canUseTool (commandDecision). Codex runs
 * commands inside its sandbox without asking, so for Codex an allow rule lets a
 * command leave the sandbox when Codex asks to, and a deny rule refuses that.
 */

export const BASES = ['read-only', 'workspace-write', 'full-access'];
const RANK = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
/** Agents that advise, review or watch: their profiles stay read-only. */
export const ADVISORS = ['oracle', 'reviewer', 'supervisor'];
/**
 * Team roles that advise or review. A member serving in one is read-only whatever its name, its
 * agent.json mode or a profile settings give it: callers pass `readOnly` for such a member.
 */
export const READ_ONLY_ROLES = ['advisor', 'reviewer'];
export const MAX_RULES = 200;
const NAME = /^[\w.-]{1,64}$/;
const RULE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s;
/** Tools a rule may name; a misspelt one would silently match nothing. MCP tools are mcp__<server>__<tool>. */
export const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill'];

const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;
const setOwn = (value, key, entry) => Object.defineProperty(value, key, { value: entry, enumerable: true, writable: true, configurable: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (source, message) => { throw new AlpError('INVALID_SETTINGS', `${source}: ${message}`); };

/** Parses one rule; returns { tool, specifier? } or throws. */
export function parseRule(rule, source = 'rule') {
  if (typeof rule !== 'string' || rule.length > 500) fail(source, 'a rule is text of at most 500 characters');
  const match = RULE.exec(rule.trim());
  if (!match) fail(source, `${JSON.stringify(rule)} is not Tool or Tool(specifier)`);
  const [, tool, specifier] = match;
  if (!TOOLS.includes(tool) && !/^mcp__[\w-]+(__[\w-]+)?$/.test(tool)) fail(source, `${JSON.stringify(rule)} names unknown tool ${tool}; use ${TOOLS.join(', ')} or mcp__<server>__<tool>`);
  if (specifier !== undefined && !specifier.trim()) fail(source, `${JSON.stringify(rule)} has an empty specifier`);
  if (specifier !== undefined && specifier.trim().startsWith('@')) {
    const checked = checkedRule(specifier.trim());
    if (tool !== 'Bash' || !checked) fail(source, `${JSON.stringify(rule)}: a checked rule is Bash(@git-clone-public <root>), Bash(@git-read <root>) or Bash(@git-unsafe), with <root> an absolute, normalised path or ~/<dir>`);
  }
  return { tool, ...(specifier !== undefined && specifier.trim() !== '*' ? { specifier: specifier.trim() } : {}) };
}

/** Checks the `permissions` field of a settings file. */
export function validatePermissions(value, source) {
  if (value === undefined) return { profiles: {}, agents: {} };
  if (!object(value)) fail(source, 'permissions must be an object');
  for (const key of Object.keys(value)) if (!['profiles', 'agents'].includes(key)) fail(source, `unsupported permissions field '${key}'`);
  const profiles = {};
  if (value.profiles !== undefined) {
    if (!object(value.profiles)) fail(source, 'permissions.profiles must be an object');
    for (const [name, profile] of Object.entries(value.profiles)) {
      const where = `permissions.profiles.${name}`;
      if (!NAME.test(name)) fail(source, `${where}: a profile name has letters, digits, dots, dashes and underscores`);
      if (!object(profile)) fail(source, `${where} must be an object`);
      for (const key of Object.keys(profile)) if (!['base', 'allow', 'ask', 'deny', 'beyondMode', 'workdir'].includes(key)) fail(source, `${where}: unsupported field '${key}'`);
      if (profile.workdir !== undefined && profile.workdir !== 'copy') fail(source, `${where}.workdir must be copy`);
      if (profile.workdir === 'copy' && profile.base !== undefined && profile.base !== 'read-only') fail(source, `${where}: workdir copy is for read-only profiles; writers use worktree isolation`);
      if (profile.base !== undefined && !BASES.includes(profile.base)) fail(source, `${where}.base must be ${BASES.join(', ')}`);
      if (profile.beyondMode !== undefined && !['refuse', 'ask'].includes(profile.beyondMode)) fail(source, `${where}.beyondMode must be refuse or ask`);
      const rules = {};
      for (const kind of ['allow', 'ask', 'deny']) {
        const list = profile[kind] ?? [];
        if (!Array.isArray(list) || list.length > MAX_RULES) fail(source, `${where}.${kind} must list at most ${MAX_RULES} rules`);
        for (const rule of list) parseRule(rule, `${source}: ${where}.${kind}`);
        rules[kind] = list.map(rule => rule.trim());
      }
      setOwn(profiles, name, { ...(profile.base ? { base: profile.base } : {}), ...(profile.beyondMode ? { beyondMode: profile.beyondMode } : {}), ...(profile.workdir ? { workdir: profile.workdir } : {}), ...rules });
    }
  }
  const agents = {};
  if (value.agents !== undefined) {
    if (!object(value.agents)) fail(source, 'permissions.agents must be an object');
    for (const [agent, profile] of Object.entries(value.agents)) {
      if (typeof profile !== 'string' || !NAME.test(profile)) fail(source, `permissions.agents.${agent} must name a profile`);
      setOwn(agents, agent, profile);
    }
  }
  return { profiles, agents };
}

async function settingsPermissions(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { profiles: {}, agents: {} }; throw error; }
  let settings;
  try { settings = JSON.parse(text); } catch (error) { fail(file, `invalid JSON: ${error.message}`); }
  if (!object(settings)) fail(file, 'expected an object');
  return validatePermissions(settings.permissions, file);
}

/**
 * The permission profile of an agent, or null when none applies: then the agent
 * keeps the runtime's defaults. Advisors without a profile get a read-only one.
 * `workdir: 'copy'` runs the agent in a disposable copy of its requester's tree,
 * where it may write, build and test; the requester's tree stays untouched.
 * `readOnly` (a member serving as a team advisor or reviewer, READ_ONLY_ROLES): the profile is
 * capped at read-only, and a profile settings give it with a higher base is capped, not obeyed;
 * its rules still apply, as they do for the built-in advisors.
 * @param {{ readOnly?: boolean }} [options]
 * @returns {Promise<{ name: string, base: string, allow: string[], ask: string[], deny: string[], beyondMode: 'refuse' | 'ask', workdir?: 'copy' } | null>}
 */
export async function profileFor(projectRoot, home, agent, { readOnly = false } = {}) {
  const project = await settingsPermissions(path.join(projectRoot, '.alp', 'settings.json'));
  const user = home ? await settingsPermissions(path.join(home, 'settings.json')) : { profiles: {}, agents: {} };
  const name = own(project.agents, agent) ?? own(user.agents, agent);
  const advisor = ADVISORS.includes(agent);
  if (!name) return advisor || readOnly ? { name: 'read-only', base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse' } : null;
  const defined = [own(project.profiles, name), own(user.profiles, name)].filter(Boolean);
  if (!defined.length && !BASES.includes(name)) {
    throw new AlpError('INVALID_SETTINGS', `permissions.agents.${agent} names profile '${name}', which no settings file defines`);
  }
  // A bare base name is a profile with no rules.
  const base = defined.find(profile => profile.base)?.base ?? (BASES.includes(name) ? name : advisor ? 'read-only' : 'full-access');
  const copy = defined.some(profile => profile.workdir === 'copy');
  if (copy && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `Profile '${name}' has workdir copy, which needs base read-only`);
  if (advisor && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `${agent} is an advisor; its profile '${name}' must have base read-only`);
  return {
    name, base: readOnly ? 'read-only' : base,
    ...(readOnly && base !== 'read-only' ? { cappedFrom: base } : {}),
    allow: [...new Set(defined.flatMap(profile => profile.allow ?? []))],
    ask: [...new Set(defined.flatMap(profile => profile.ask ?? []))],
    deny: [...new Set(defined.flatMap(profile => profile.deny ?? []))],
    beyondMode: defined.find(profile => profile.beyondMode)?.beyondMode ?? 'refuse',
    ...(copy ? { workdir: 'copy' } : {}),
  };
}

/**
 * Adds an allow rule to a profile, in the settings file that defines it (the
 * project's first), when the user allows something always. Returns the file.
 */
export async function addAllowRule(projectRoot, home, profileName, rule) {
  parseRule(rule);
  for (const file of [path.join(projectRoot, '.alp', 'settings.json'), ...(home ? [path.join(home, 'settings.json')] : [])]) {
    let settings;
    try { settings = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const profile = settings?.permissions?.profiles?.[profileName];
    if (!object(profile)) continue;
    profile.allow = [...new Set([...(profile.allow ?? []), rule])];
    validatePermissions(settings.permissions, file);
    const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    await moveFile(temporary, file);
    return file;
  }
  throw new AlpError('INVALID_SETTINGS', `No settings file defines profile ${profileName}`);
}

/** The lower of two modes. */
export const capMode = (mode, base) => (RANK[mode] ?? 0) <= (RANK[base] ?? 0) ? mode : base;

// --- commands --------------------------------------------------------------------

/** Removes a shell wrapper such as `/bin/zsh -lc '...'` that Codex puts around a command. */
export function unwrapShell(command) {
  // The quotes must enclose the whole rest of the line: `sh -c '<a>' ; <b> 'c'` is two commands, not one
  // script (a greedy match read `<a>' ; <b> 'c` as the script, so a rule covering <a> covered <b>).
  const match = /^(?:\/\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\[\s\S])*)")\s*$/.exec(command.trim());
  if (!match) return command.trim();
  // In double quotes the outer shell expands `$…` and backticks before sh runs: the script read here is not
  // the one that runs, so the line stays as it is (Codex escapes them in its own wrapper).
  if (match[2] !== undefined && /(?:^|[^\\])(?:\\\\)*[$`]/.test(match[2])) return command.trim();
  return match[1] !== undefined ? match[1].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, '$1');
}

/**
 * Splits a command line into its simple commands at `&&`, `||`, `;`, `|` and new
 * lines, outside quotes. Returns null when the line substitutes commands or
 * processes, or its quotes do not close: no rule can vouch for it.
 */
export function simpleCommands(line) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') { current += char + (line[++i] ?? ''); continue; }
      if (char === quote) quote = null;
      if (quote === '"' && (char === '`' || (char === '$' && line[i + 1] === '('))) return null;
      current += char;
      continue;
    }
    if (char === '\\') { current += char + (line[++i] ?? ''); continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    // A `#` that starts a word begins a comment the shell skips: what follows (a quote, a new line) is read
    // differently by the shell than here, so no rule can vouch for the line (t-cde5 review).
    if (char === '#' && (i === 0 || /[\s;|&()]/.test(line[i - 1]))) return null;
    // Any unquoted `(`: command and process substitution, zsh's `=(…)` and glob qualifiers `*(e:…)`, subshells.
    // ALP cannot say what such a line runs, so no rule vouches for it (t-cde5 review).
    if (char === '`' || char === '(') return null;
    const two = line.slice(i, i + 2);
    // 2>&1 and &>file redirect; they do not end a command.
    if (two === '>&' || two === '<&' || two === '&>') { current += two; i++; continue; }
    if (two === '&&' || two === '||') { parts.push(current); current = ''; i++; continue; }
    if (char === ';' || char === '|' || char === '\n' || char === '&') { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (quote) return null;
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

// --- checked git rules ----------------------------------------------------------
//
// A prefix rule cannot say "a directory under <root>": `Bash(git -C /r/*)` also covers `git -C /r/../x push`.
// A checked rule names a command shape ALP parses into words
// and checks argument by argument. Its specifier starts with `@`, so a runtime that matches rules itself as
// written (Claude's allowedTools, disallowedTools) matches it against no real command: it holds only where ALP
// decides (commandDecision), and never widens anything elsewhere. <root> is absolute, or `~/<dir>` in the home of
// the user ALP runs as; it must be that user's own 0700 directory (safeRoot).
//
//   Bash(@git-clone-public <root>)  allow `git clone [--depth N|--shallow-since=D|--filter=F|--single-branch|
//                                   --no-tags|-b B|-q|-n|--progress] https://(github|gitlab).com/<o>/<r>[.git] <dest>`,
//                                   <dest> absolute, normalised and strictly below <root>, also once links are resolved
//   Bash(@git-read <root>)          allow `git [--no-pager] -C <dir> <fetch|log|show|grep|rev-parse|ls-files|cat-file|
//                                   blame|diff|branch> ...`, <dir> strictly below <root> the same way; fetch only from
//                                   origin with listed options; branch only lists; the others only with the options
//                                   GIT_OPTIONS lists for them, matched exactly (no abbreviation, no unlisted letter)
//   Bash(@git-unsafe)               deny any git invocation that pushes, configures, edits remotes, runs hooks, or
//                                   carries -c/--config-env, --upload-pack, --receive-pack, --config, --template, --exec,
//                                   or -u to clone/fetch/pull/ls-remote; a git command ALP cannot split into words too

const CHECKED_KINDS = ['git-clone-public', 'git-read', 'git-unsafe'];

/** Parses a checked specifier: { kind, root? } or null. */
function checkedRule(specifier) {
  const match = /^@([a-z-]+)(?:\s+(\S+))?$/.exec(specifier);
  if (!match || !CHECKED_KINDS.includes(match[1])) return null;
  const [, kind, root] = match;
  if (kind === 'git-unsafe') return root === undefined ? { kind } : null;
  // <root> is an absolute path in normal form, or `~/<dir>`: <dir> in the home of the user ALP runs as.
  if (root === undefined || !cleanAbsolute(root.startsWith('~/') ? root.slice(1) : root) || ['/', '~/'].includes(root)) return null;
  return { kind, root };
}

/** An absolute POSIX path in normal form: no `.`/`..` segment, no `//`, no trailing `/`, no `~`. */
function cleanAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/') && path.posix.normalize(value) === value && (value === '/' || !value.endsWith('/'));
}

/**
 * Splits a simple command into words for a checked rule. Returns null for anything whose words the shell
 * would still change: an unquoted `$`, glob, brace, `~` at a word's start, redirect, backslash or `&`, or a
 * `$`/backtick inside double quotes.
 */
function shellWords(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === ' ' || char === '\t') { if (word !== null) words.push(word); word = null; continue; }
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? '') + command.slice(i + 1, end); i = end; continue;
    }
    if (char === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return null;
      const inner = command.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return null;
      word = (word ?? '') + inner; i = end; continue;
    }
    if (/[$*?[\]{}<>\\&|;()`!]/.test(char) || ((char === '~' || char === '#') && word === null)) return null;
    word = (word ?? '') + char;
  }
  if (word !== null) words.push(word);
  return words;
}

const WRAPPERS = ['env', 'command', 'exec', 'nice', 'nohup', 'time'];
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The words of a git invocation, from `git` on, past assignments and simple wrappers; null when it is not git. */
function gitWords(words) {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.includes(words[i]) || (i > 0 && WRAPPERS.includes(words[i - 1]) && words[i].startsWith('-')))) i++;
  return words[i] !== undefined && path.posix.basename(words[i]) === 'git' ? words.slice(i) : null;
}

const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--list-cmds'];

/** Splits `git <global options> <subcommand> <args>`. */
function parseGit(words) {
  const globals = [];
  let i = 1;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const word = words[i];
    const equals = word.indexOf('=');
    const name = word.startsWith('--') && equals > 0 ? word.slice(0, equals) : word;
    if (word.startsWith('--') && equals > 0) globals.push({ name, value: word.slice(equals + 1) });
    else if (GIT_VALUE_OPTIONS.includes(word)) globals.push({ name, value: words[++i] });
    else if (/^-[Cc]./.test(word)) globals.push({ name: word.slice(0, 2), value: word.slice(2) });
    else globals.push({ name });
  }
  return { globals, sub: words[i], args: words.slice(i + 1) };
}

const NETWORK = ['clone', 'fetch', 'pull', 'ls-remote', 'submodule'];
const SAFE_REMOTE = [[], ['-v'], ['--verbose']];

/** Whether a parsed git invocation pushes, configures, runs a program, or overrides config. */
function gitUnsafe({ globals, sub, args }) {
  if (globals.some(option => option.name === '-c' || option.name === '--config-env' || option.name === '--exec-path' && option.value !== undefined)) return true;
  if (['push', 'send-pack', 'config', 'hook'].includes(sub)) return true;
  if (sub === 'remote' && !SAFE_REMOTE.some(safe => safe.length === args.length && safe.every((word, i) => word === args[i])) && !['get-url', 'show'].includes(args[0])) return true;
  if (args.some(word => /^--(upload-pack|receive-pack|config|template|exec)(=|$)/.test(word))) return true;
  if (NETWORK.includes(sub) && args.some(word => /^-[A-Za-z]*[uc]/.test(word))) return true;
  return false;
}

/** The real form of a path that may not exist yet: its deepest existing ancestor resolved, the rest appended. */
function realForm(target) {
  let existing = target;
  const rest = [];
  for (;;) {
    try { lstatSync(existing); break; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...rest);
}

/** Whether `target`, written in normal form, lies strictly below `base`, also once links are resolved. */
function inside(target, base) {
  if (!cleanAbsolute(target) || !target.startsWith(`${base}/`)) return false;
  try { return realForm(target).startsWith(`${realForm(base)}${path.sep}`); } catch { return false; }
}

/**
 * The directory a checked rule's root names, once it is safe to write below; null when it is not.
 * `~/<dir>` is that directory in the home of the user ALP runs as (os.homedir()). A root in a shared /tmp (the research
 * pack's /tmp/alp-librarian) can be squatted by another local user: then it fails the checks below and every command
 * asks (denial of service, never a hijack). The root must be a real
 * directory (not a link) owned by this user with no group or other access (mode 0700), in a parent that no one
 * else may rename it in. `create` (a clone) makes a missing root with mode 0700 first; a read needs it to exist.
 * Windows has no uid or POSIX mode to check, and its paths cannot be written in a command ALP splits (a
 * backslash or drive letter): there no root is safe and the checked allow rules allow nothing, so clones ask.
 */
/** The absolute directory a checked rule's root names (`~/<dir>` in the home ALP runs as), or null. No I/O. */
function rootPath(rule) {
  let root = rule;
  if (rule.startsWith('~/')) {
    const home = homedir();
    if (!cleanAbsolute(home) || home === '/') return null;
    root = `${home}${rule.slice(1)}`;
  }
  return cleanAbsolute(root) && root !== '/' ? root : null;
}

function safeRoot(rule, create) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  const root = rootPath(rule);
  if (root === null) return null;
  try {
    // Others who may write the parent could rename the root away and put their own in its place, unless it is sticky (/tmp).
    const parent = statSync(realpathSync.native(path.dirname(root)));
    if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) return null;
    let info = lstatSync(root, { throwIfNoEntry: false });
    if (!info && create) {
      try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') return null; }
      info = lstatSync(root, { throwIfNoEntry: false });
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return null;
    return root;
  } catch { return null; }
}

/** Whether `target` lies strictly below a checked rule's root, and that root is safe to write below (safeRoot). */
function below(target, rule, create = false) {
  // Written below the root first, so a command for anywhere else never makes the root (safeRoot's mkdir).
  const named = rootPath(rule);
  if (named === null || !cleanAbsolute(target) || !target.startsWith(`${named}/`)) return false;
  const root = safeRoot(rule, create);
  return root !== null && inside(target, root);
}

const PUBLIC_REPO = /^https:\/\/(?:github\.com|gitlab\.com)\/([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/;
const REF = /^[A-Za-z0-9_][\w./-]*$/;
const goodRef = value => typeof value === 'string' && REF.test(value) && !value.split('/').includes('..') && !value.includes('..');

function cloneAllowed({ globals, sub, args }, root) {
  if (globals.length || sub !== 'clone') return false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!word.startsWith('-')) { positional.push(word); continue; }
    if (['--single-branch', '--no-single-branch', '--no-tags', '-q', '--quiet', '-n', '--no-checkout', '--progress'].includes(word)) continue;
    if (word === '--depth') { if (!/^\d+$/.test(args[++i] ?? '')) return false; continue; }
    if (/^--depth=\d+$/.test(word) || /^--shallow-since=[\w:+.-]+$/.test(word) || /^--filter=(?:blob:none|tree:0|blob:limit=\d+[kmg]?)$/.test(word)) continue;
    if (word === '-b' || word === '--branch') { if (!goodRef(args[++i])) return false; continue; }
    if (word.startsWith('--branch=') && goodRef(word.slice(9))) continue;
    return false;
  }
  if (positional.length !== 2) return false;
  const [url, destination] = positional;
  const repo = PUBLIC_REPO.exec(url);
  if (!repo || ['.', '..'].includes(repo[1]) || ['.', '..', ''].includes(repo[2])) return false;
  return below(destination, root, true);
}

const READS = ['fetch', 'log', 'show', 'grep', 'rev-parse', 'ls-files', 'cat-file', 'blame', 'diff', 'branch'];
const FETCH_FLAGS = ['--unshallow', '--tags', '--no-tags', '--prune', '-p', '--prune-tags', '--all', '-q', '--quiet', '-v', '--verbose', '--force', '-f', '--no-recurse-submodules', '--progress'];
const BRANCH_FLAGS = ['-a', '-r', '--all', '--remotes', '-v', '-vv', '--verbose', '--list', '--no-color'];

// The options each reading subcommand may carry: an ALLOWLIST, matched exactly. git's parse-options accepts any
// unambiguous abbreviation of a long option (`grep --open=sh` is --open-files-in-pager) and clusters of short
// ones (`grep -iOsh`), so a word is allowed only when it is one of these names as written, or a cluster of
// listed short letters. Nothing here writes a file, runs a program, or names a file to read (no --output,
// -O, --open-files-in-pager, --ext-diff, --textconv, --no-index, -f/--file, --contents, -S <file> for blame,
// --ignore-revs-file, --exclude-from, -X, --orderfile/-O); the values the listed options take are checked too.
//   long: name -> 'flag' (`--x`), 'optional' (`--x` or `--x=v`), 'value' (`--x=v` or `--x v`)
//   flags: short letters with no value; optional: short letters whose value, if any, is attached digits;
//   values: short letters that take a value, attached or the next word; numeric: `-<n>` is allowed
const longs = (kind, names) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map(name => [`--${name}`, kind]));
const DIFF_LONG = {
  ...longs('flag', 'patch no-patch raw numstat shortstat summary name-only name-status patch-with-stat compact-summary full-index binary no-abbrev minimal patience histogram ignore-all-space ignore-space-change ignore-space-at-eol ignore-blank-lines ignore-cr-at-eol function-context no-color no-renames text no-ext-diff no-textconv irreversible-delete pickaxe-all pickaxe-regex exit-code quiet no-prefix check'),
  ...longs('optional', 'stat dirstat abbrev word-diff color-words find-renames find-copies break-rewrites color'),
  ...longs('value', 'unified diff-filter inter-hunk-context diff-algorithm word-diff-regex anchored'),
};
const LOG_LONG = {
  ...DIFF_LONG,
  ...longs('flag', 'oneline graph all branches tags remotes reverse first-parent no-merges merges follow abbrev-commit no-abbrev-commit no-decorate source left-right boundary date-order topo-order author-date-order regexp-ignore-case extended-regexp fixed-strings basic-regexp perl-regexp all-match invert-grep full-history simplify-merges simplify-by-decoration ancestry-path cherry-pick cherry-mark no-walk do-walk parents children log-size mailmap use-mailmap no-mailmap cc combined-all-paths dense sparse'),
  ...longs('optional', 'decorate pretty'),
  ...longs('value', 'max-count skip since after until before author committer grep format date min-parents max-parents'),
};
const DIFF_SHORT = { flags: 'puswbWRaz', optional: 'MCB', values: 'USG' };
const GIT_OPTIONS = {
  log: { long: LOG_LONG, flags: `${DIFF_SHORT.flags}iEFPm`, optional: DIFF_SHORT.optional, values: `${DIFF_SHORT.values}nL`, numeric: true },
  show: { long: LOG_LONG, flags: `${DIFF_SHORT.flags}iEFPm`, optional: DIFF_SHORT.optional, values: `${DIFF_SHORT.values}nL`, numeric: true },
  diff: { long: { ...DIFF_LONG, ...longs('flag', 'cached staged merge-base') }, ...DIFF_SHORT, numeric: false },
  grep: {
    long: {
      ...longs('flag', 'cached untracked exclude-standard no-exclude-standard text ignore-case word-regexp invert-match full-name extended-regexp basic-regexp fixed-strings perl-regexp line-number column name-only files-with-matches files-without-match count only-matching null heading break show-function function-context all-match and or not quiet no-color recursive no-recursive'),
      ...longs('optional', 'color'),
      ...longs('value', 'max-depth max-count context after-context before-context threads'),
    },
    flags: 'aiIwvhHnlLcoqzpWEGFPr', optional: '', values: 'eABCm', numeric: true,
  },
  blame: {
    long: { ...longs('flag', 'root show-stats porcelain line-porcelain incremental show-name show-number show-email minimal reverse first-parent'), ...longs('optional', 'abbrev'), ...longs('value', 'date ignore-rev') },
    flags: 'bltsewnfpc', optional: 'MC', values: 'L', numeric: false,
  },
  'rev-parse': {
    long: { ...longs('flag', 'verify quiet symbolic symbolic-full-name show-toplevel show-prefix show-cdup is-inside-work-tree is-inside-git-dir is-bare-repository is-shallow-repository git-dir absolute-git-dir all branches tags remotes'), ...longs('optional', 'short abbrev-ref'), ...longs('value', 'default') },
    flags: 'q', optional: '', values: '', numeric: false,
  },
  'ls-files': {
    long: { ...longs('flag', 'cached deleted modified others stage killed directory no-empty-directory unmerged full-name error-unmatch eol deduplicate sparse'), ...longs('optional', 'abbrev'), ...longs('value', 'format') },
    flags: 'cdmoskutvfz', optional: '', values: '', numeric: false,
  },
  'cat-file': {
    long: { ...longs('flag', 'batch-all-objects unordered buffer'), ...longs('optional', 'batch batch-check') },
    flags: 'tsep', optional: '', values: '', numeric: false,
  },
};

/** A word that names something inside the clone: an absolute path below it, or a relative one with no `..`, `//` or `.` segment. */
function insideClone(word, dir) {
  if (word.startsWith('~')) return false;
  if (word.startsWith('/')) return inside(word, dir);
  // `rev:path` and `-L 1,2:path` name a path after a colon: it is checked as a segment too.
  return !word.replace(/^\.\//, '').split(/[/:]/).some((segment, i, all) => segment === '..' || (segment === '.' && all.length > 1) || (segment === '' && i > 0));
}

/** Whether every option of a reading subcommand is on its allowlist, and every value and path stays in the clone. */
function readOptionsAllowed(spec, args, dir) {
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (paths || !word.startsWith('-') || word === '-') { if (!insideClone(word, dir)) return false; continue; }
    if (word === '--') { paths = true; continue; }
    // A value given as the next word must not itself look like an option: git and ALP then agree on what it is.
    const next = () => { const value = args[++i]; return value !== undefined && !value.startsWith('-') && insideClone(value, dir); };
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = equals > 0 ? word.slice(0, equals) : word;
      const kind = Object.hasOwn(spec.long, name) ? spec.long[name] : undefined;
      if (kind === undefined) return false;
      if (equals > 0) { if (kind === 'flag' || !insideClone(word.slice(equals + 1), dir)) return false; continue; }
      if (kind === 'value' && !next()) return false;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(word)) continue;
    // A cluster of short options: every letter listed; a value letter takes the rest of the word, or the next word.
    for (let j = 1; j < word.length; j++) {
      const letter = word[j];
      if (spec.flags.includes(letter)) continue;
      const rest = word.slice(j + 1);
      if (spec.optional.includes(letter)) { if (!/^\d*%?$/.test(rest)) return false; break; }
      if (spec.values.includes(letter)) { if (rest ? !insideClone(rest, dir) : !next()) return false; break; }
      return false;
    }
  }
  return true;
}

function readAllowed({ globals, sub, args }, root) {
  const dirs = globals.filter(option => option.name === '-C');
  if (dirs.length !== 1 || globals.some(option => !['-C', '--no-pager', '-P'].includes(option.name))) return false;
  if (!below(dirs[0].value, root) || !READS.includes(sub)) return false;
  if (sub === 'fetch') {
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (!word.startsWith('-')) { positional.push(word); continue; }
      if (FETCH_FLAGS.includes(word)) continue;
      if (word === '--depth' || word === '--deepen') { if (!/^\d+$/.test(args[++i] ?? '')) return false; continue; }
      if (/^--(?:depth|deepen)=\d+$/.test(word) || /^--shallow-since=[\w:+.-]+$/.test(word) || /^--filter=(?:blob:none|tree:0|blob:limit=\d+[kmg]?)$/.test(word)) continue;
      return false;
    }
    // Only from origin, the repository it was cloned from: never a URL or a local path.
    if (positional.length && positional[0] !== 'origin') return false;
    return positional.slice(1).every(spec => spec.split(':').every(goodRef));
  }
  if (sub === 'branch') return args.every(word => BRANCH_FLAGS.includes(word));
  return readOptionsAllowed(GIT_OPTIONS[sub], args, dirs[0].value);
}

/** Whether a checked rule covers one simple command (deny: also git ALP cannot split into words). */
function coversChecked(checked, command) {
  const raw = command.trim().split(/\s+/);
  const words = shellWords(command);
  if (checked.kind === 'git-unsafe') {
    if (!words) {
      // Words the shell would still change: judged on their face once quotes and escaping backslashes are taken
      // out (`pu\sh`, `p'u'sh` are push), and a git subcommand ALP cannot read is denied.
      const git = gitWords(raw.map(word => word.replace(/\\(.)/g, '$1').replace(/['"]/g, '')));
      if (git === null) return false;
      const parsed = parseGit(git);
      return gitUnsafe(parsed) || git.includes('push') || parsed.sub === undefined || /[^\w-]/.test(parsed.sub);
    }
    // `sh -c '...'`: the script is checked as commands of its own.
    if (/^(?:\/\S*\/)?(?:ba|z|da)?sh$/.test(words[0] ?? '') && /^-\w*c\w*$/.test(words[1] ?? '') && typeof words[2] === 'string') {
      const inner = simpleCommands(words[2]);
      return !inner || inner.some(part => coversChecked(checked, part));
    }
    const git = gitWords(words);
    return git !== null && gitUnsafe(parseGit(git));
  }
  if (!words) return false;
  // Allowed only as plain `git ...`: no assignment, wrapper or other git binary in front.
  if (words[0] !== 'git') return false;
  const parsed = parseGit(words);
  if (gitUnsafe(parsed)) return false;
  return checked.kind === 'git-clone-public' ? cloneAllowed(parsed, checked.root) : readAllowed(parsed, checked.root);
}

/**
 * Whether the paths a command names are in normal form, for an allow rule whose specifier names a path:
 * no `..` or `.` segment (a leading `./` aside), no `//`, no `~` at the start. `x/..` can leave any prefix.
 */
function normalPaths(command) {
  for (const raw of command.split(/\s+/)) {
    const word = raw.replace(/^['"]+|['"]+$/g, '').replace(/^--?[\w-]+=/, '');
    if (word.startsWith('~')) return false;
    const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(.*)$/i.exec(word);
    const pathPart = url ? url[1] : word;
    if (!pathPart.includes('/') && pathPart !== '..') continue;
    const segments = pathPart.replace(/^\.\//, '').split('/');
    if (segments.some((segment, i) => segment === '..' || segment === '.' || (segment === '' && i > 0 && i < segments.length - 1))) return false;
  }
  return true;
}

/** Whether a Bash rule's specifier covers one simple command. */
function covers(specifier, command) {
  if (specifier === undefined) return true;
  if (specifier.startsWith('@')) { const checked = checkedRule(specifier); return Boolean(checked) && coversChecked(checked, command); }
  const normalized = command.replace(/\s+/g, ' ');
  // `npm test:*` and `npm test *` both cover npm test and anything after it.
  if (specifier.endsWith(':*') || specifier.endsWith(' *')) {
    const prefix = specifier.slice(0, -2).trim().replace(/\s+/g, ' ');
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  if (specifier.endsWith('*')) return normalized.startsWith(specifier.slice(0, -1).replace(/\s+/g, ' '));
  return normalized === specifier.replace(/\s+/g, ' ');
}

/** Whether a simple command writes a file through a redirect (not a descriptor or /dev/null). */
function redirects(command) {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const match of unquoted.matchAll(/(?:\d*|&)>>?\s*(&?)(\S*)/g)) {
    if (match[1] === '&' && /^\d+$/.test(match[2])) continue;
    if (match[2] === '/dev/null') continue;
    return true;
  }
  return false;
}

const bashRules = rules => rules.map(rule => parseRule(rule)).filter(rule => rule.tool === 'Bash');

/**
 * What a profile says about running a command: 'deny' when a deny rule covers any
 * of its simple commands, 'ask' when an ask rule covers any, 'allow' when allow
 * rules cover every one of them and none writes through a redirect, otherwise
 * undefined (the base mode decides).
 */
export function commandDecision(profile, command) {
  const line = unwrapShell(command);
  const parts = simpleCommands(line);
  const deny = bashRules(profile.deny);
  if (deny.some(rule => rule.specifier === undefined)) return 'deny';
  // A command ALP cannot split may hide anything a deny rule names.
  if (!parts) return deny.length ? 'deny' : (profile.ask ?? []).length ? 'ask' : undefined;
  if (parts.some(part => deny.some(rule => covers(rule.specifier, part)))) return 'deny';
  const allow = bashRules(profile.allow);
  // A checked allow rule names exactly what it lets through, so it wins over a broader ask rule
  // (`Bash(git clone:*)` asks about every clone but the checked one); deny still wins over both.
  const checkedAllow = part => allow.some(rule => rule.specifier?.startsWith('@') && covers(rule.specifier, part));
  const ask = bashRules(profile.ask ?? []);
  if (ask.some(rule => rule.specifier === undefined) || parts.some(part => !checkedAllow(part) && ask.some(rule => covers(rule.specifier, part)))) return 'ask';
  // A rule that names a path covers only commands whose paths are in normal form: `x/../y` leaves any prefix.
  const allowed = part => allow.some(rule => covers(rule.specifier, part) && (rule.specifier === undefined || rule.specifier.startsWith('@') || !/[/~]/.test(rule.specifier) || normalPaths(part)));
  if (parts.every(part => !redirects(part) && allowed(part))) return 'allow';
  return undefined;
}
