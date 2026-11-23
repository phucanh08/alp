import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
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
    if (tool !== 'Bash' || !checked) fail(source, `${JSON.stringify(rule)}: a checked rule is Bash(@git-clone-public <root>), Bash(@git-read <root>) or Bash(@git-unsafe), with <root> an absolute, normalised path`);
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
  const match = /^(?:\/\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  if (!match) return command.trim();
  return match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, '$1');
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
    if (char === '`' || (char === '$' && line[i + 1] === '(') || ((char === '<' || char === '>') && line[i + 1] === '(')) return null;
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
// A prefix rule cannot say "a directory under /tmp/alp-librarian": `Bash(git -C /tmp/alp-librarian/*)` also
// covers `git -C /tmp/alp-librarian/../x push`. A checked rule names a command shape ALP parses into words
// and checks argument by argument. Its specifier starts with `@`, so a runtime that matches rules itself as
// written (Claude's allowedTools, disallowedTools) matches it against no real command: it holds only where ALP
// decides (commandDecision), and never widens anything elsewhere.
//
//   Bash(@git-clone-public <root>)  allow `git clone [--depth N|--shallow-since=D|--filter=F|--single-branch|
//                                   --no-tags|-b B|-q|-n|--progress] https://(github|gitlab).com/<o>/<r>[.git] <dest>`,
//                                   <dest> absolute, normalised and strictly below <root>, also once links are resolved
//   Bash(@git-read <root>)          allow `git [--no-pager] -C <dir> <fetch|log|show|grep|rev-parse|ls-files|cat-file|
//                                   blame|diff|branch> ...`, <dir> strictly below <root> the same way; fetch only from
//                                   origin with listed options; branch only lists; no option that writes or runs a program
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
  if (root === undefined || !cleanAbsolute(root) || root === '/') return null;
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
    if (/[$*?[\]{}<>\\&|;()`!]/.test(char) || (char === '~' && word === null)) return null;
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

/**
 * Whether `target` lies strictly below `root`: written in normal form, and still below it once links are
 * resolved. An existing root must be this user's own directory, not someone else's in a shared /tmp.
 */
function below(target, root) {
  if (!cleanAbsolute(target) || !target.startsWith(`${root}/`)) return false;
  try {
    const info = lstatSync(root, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) return false;
    const realRoot = realForm(root);
    return realForm(target).startsWith(`${realRoot}${path.sep}`);
  } catch { return false; }
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
  return below(destination, root);
}

const READS = ['fetch', 'log', 'show', 'grep', 'rev-parse', 'ls-files', 'cat-file', 'blame', 'diff', 'branch'];
const FETCH_FLAGS = ['--unshallow', '--tags', '--no-tags', '--prune', '-p', '--prune-tags', '--all', '-q', '--quiet', '-v', '--verbose', '--force', '-f', '--no-recurse-submodules', '--progress'];
const BRANCH_FLAGS = ['-a', '-r', '--all', '--remotes', '-v', '-vv', '--verbose', '--list', '--no-color'];
/** Options of the reading subcommands that write a file, run a program, or read outside the repository. */
const WRITES_OR_RUNS = /^(?:--output(?:=|$)|--ext-diff$|--open-files-in-pager|-O|--no-index$|--textconv$|--filters$)/;

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
  for (const word of args) {
    if (WRITES_OR_RUNS.test(word)) return false;
    // A path argument stays inside the clone, in normal form (a revision range a..b is no path).
    if (word.startsWith('/') && !below(word, dirs[0].value)) return false;
    if (word.replace(/^\.\//, '').split('/').some((segment, i, all) => segment === '..' || (segment === '.' && all.length > 1) || (segment === '' && i > 0))) return false;
  }
  return true;
}

/** Whether a checked rule covers one simple command (deny: also git ALP cannot split into words). */
function coversChecked(checked, command) {
  const raw = command.trim().split(/\s+/);
  const words = shellWords(command);
  if (checked.kind === 'git-unsafe') {
    if (!words) {
      // Words the shell would still change: judged on their face, and a git subcommand ALP cannot read is denied.
      const git = gitWords(raw.map(word => word.replace(/^['"]+|['"]+$/g, '')));
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
