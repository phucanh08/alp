#!/usr/bin/env node
// check-boundaries: checks a JavaScript/TypeScript repository's imports against its architecture
// contract (docs/architecture/contract.json by default). No dependencies, reads only, runs nothing.
//
//   node check-boundaries.mjs [--root DIR] [--contract FILE] [--base GIT-REF [--approved-by NAME]] [--json]
//
// Exit 0: no violations. Exit 1: violations (each printed as file:line), or with --base a change to
// the contract that loosens it (an added exception, a wider allow list, a removed denied package, a
// new ignore, a changed module) not acknowledged with --approved-by. Exit 2: the contract or the
// arguments are invalid. The contract format is in ../references/architecture-contract.md.
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.alp']);
const KEYS = ['modules', 'allow', 'denyPackages', 'ignore', 'exceptions', '$schema', 'description'];

class ContractError extends Error {}
const toPosix = file => file.split(path.sep).join('/');

/** A glob (`**`, `*`, `?`) as a RegExp over POSIX paths relative to the root. */
export function globRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Checks the contract's shape; returns it with compiled globs. */
export function parseContract(value, source = 'contract') {
  const fail = message => { throw new ContractError(`${source}: ${message}`); };
  const list = (v, where) => { if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && x.trim())) fail(`${where} must be a list of strings`); return v; };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a JSON object');
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) fail(`unknown key '${key}'; expected ${KEYS.join(', ')}`);
  if (!value.modules || typeof value.modules !== 'object' || !Object.keys(value.modules).length) fail('modules must name at least one module and its globs');
  const modules = Object.entries(value.modules).map(([name, globs]) => ({ name, globs: list(globs, `modules.${name}`).map(globRegExp) }));
  const names = new Set(modules.map(m => m.name));
  const allow = value.allow ?? {};
  if (typeof allow !== 'object' || Array.isArray(allow)) fail('allow must map a module to the modules it may import');
  for (const [from, targets] of Object.entries(allow)) {
    if (!names.has(from)) fail(`allow names unknown module '${from}'`);
    for (const target of list(targets, `allow.${from}`)) if (!names.has(target)) fail(`allow.${from} names unknown module '${target}'`);
  }
  const denyPackages = value.denyPackages ?? {};
  for (const [from, packages] of Object.entries(denyPackages)) { if (!names.has(from)) fail(`denyPackages names unknown module '${from}'`); list(packages, `denyPackages.${from}`); }
  const ignore = list(value.ignore ?? [], 'ignore').map(globRegExp);
  const exceptions = (value.exceptions ?? []).map((exception, index) => {
    const at = `exceptions[${index}]`;
    if (!exception || typeof exception !== 'object') fail(`${at} must be an object`);
    for (const key of ['file', 'import', 'reason', 'approvedBy']) if (typeof exception[key] !== 'string' || !exception[key].trim()) fail(`${at}.${key} is required: an exception records what it allows, why, and who approved it`);
    for (const key of Object.keys(exception)) if (!['file', 'import', 'reason', 'approvedBy', 'expires'].includes(key)) fail(`${at}: unknown key '${key}'; expected file, import, reason, approvedBy, expires`);
    // An exception is narrow: one file, and not every import.
    if (/[*?]/.test(exception.file)) fail(`${at}.file must name one file, not a pattern: an exception covers a single file`);
    if (/^\*\*?(\/\*\*?)*$/.test(exception.import.trim())) fail(`${at}.import must name what may be imported, not everything`);
    if (exception.expires !== undefined && (typeof exception.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) || Number.isNaN(Date.parse(exception.expires)))) fail(`${at}.expires must be a date, YYYY-MM-DD`);
    return { ...exception, fileRe: globRegExp(exception.file), importRe: globRegExp(exception.import) };
  });
  return { modules, allow, denyPackages, ignore, exceptions };
}

/**
 * The source with comments as spaces and every string's contents as `x`, newlines kept, so
 * positions match the original: imports are found in this mask (an import inside a string or a
 * comment is not one) and their specifiers read back from the original at the same offsets.
 */
export function maskSource(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { out += '  '; i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; } if (i < text.length) { out += '  '; i += 2; } continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < text.length && text[i] !== c && !(c !== '`' && text[i] === '\n')) {
        if (text[i] === '\\' && i + 1 < text.length) { out += 'xx'; i += 2; continue; }
        out += text[i] === '\n' ? '\n' : 'x'; i++;
      }
      if (i < text.length) { out += text[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Every module specifier a source file imports, with its line: import/export from, import(), require(). */
export function importsOf(text) {
  const masked = maskSource(text);
  const found = [];
  const patterns = [/(?<![.\w$])from\s*(['"])(x+)\1/g, /(?<![.\w$])import\s*(['"])(x+)\1/g, /(?<![.\w$])import\s*\(\s*(['"])(x+)\1\s*\)/g, /(?<![.\w$])require\s*\(\s*(['"])(x+)\1\s*\)/g];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const at = match.index + match[0].lastIndexOf(match[2]);
      found.push({ specifier: text.slice(at, at + match[2].length), line: masked.slice(0, at).split('\n').length });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** The package a bare specifier names: `@scope/name`, `name`, or `node:x`. */
const packageOf = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

async function exists(file) { return stat(file).then(info => info.isFile(), () => false); }

/** A relative specifier resolved to a repository file, as TypeScript and Node would find it. */
async function resolveRelative(root, fromFile, specifier) {
  const base = path.resolve(root, path.dirname(fromFile), specifier);
  const candidates = [base, ...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => path.join(base, `index${ext}`))];
  // TypeScript's ESM style imports ./x.js for ./x.ts.
  if (/\.[cm]?js$/.test(base)) candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map(ext => base.replace(/\.[cm]?js$/, ext)));
  for (const candidate of candidates) if (await exists(candidate)) return toPosix(path.relative(root, candidate));
  return toPosix(path.relative(root, base));
}

async function sourceFiles(root, ignore) {
  const files = [];
  const walk = async relative => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(rel); }
      else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts') && !ignore.some(re => re.test(rel))) files.push(rel);
    }
  };
  await walk('');
  return files.sort();
}

/**
 * Checks `root` against its contract.
 * @returns {Promise<{ files: number, violations: Array<{ file: string, line: number, from: string, to: string, specifier: string, rule: string }>, excepted: Array<object> }>}
 */
export async function checkBoundaries(root, contractValue, { today = new Date() } = {}) {
  const contract = parseContract(contractValue);
  const day = today.toISOString().slice(0, 10);
  const used = new Set();
  const moduleOf = file => contract.modules.find(m => m.globs.some(re => re.test(file)))?.name;
  const violations = [];
  const excepted = [];
  let checked = 0;
  for (const file of await sourceFiles(root, contract.ignore)) {
    const from = moduleOf(file);
    if (!from) continue;
    checked++;
    const text = await readFile(path.join(root, file), 'utf8');
    for (const { specifier, line } of importsOf(text)) {
      let finding;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = await resolveRelative(root, file, specifier);
        const to = moduleOf(target);
        const allowed = contract.allow[from];
        if (to && to !== from && allowed && !allowed.includes(to)) finding = { file, line, from, to, specifier, target, rule: `${from} may import only ${allowed.length ? allowed.join(', ') : 'itself'}` };
      } else {
        const pkg = packageOf(specifier);
        const denied = contract.denyPackages[from] ?? [];
        if (denied.includes(pkg) || denied.includes(specifier)) finding = { file, line, from, to: pkg, specifier, target: pkg, rule: `${from} must not import package ${pkg}` };
      }
      if (!finding) continue;
      const exception = contract.exceptions.find(e => e.fileRe.test(file) && e.importRe.test(finding.target));
      if (exception) used.add(exception);
      // An exception that has expired excuses nothing: the decision is to be made again.
      if (exception && exception.expires && exception.expires < day) violations.push({ ...finding, rule: `${finding.rule} (its exception expired on ${exception.expires}; approved by ${exception.approvedBy})` });
      else if (exception) excepted.push({ ...finding, reason: exception.reason, approvedBy: exception.approvedBy, ...(exception.expires ? { expires: exception.expires } : {}) });
      else violations.push(finding);
    }
  }
  // An exception nothing needs any more: listed for review, so stale permissions do not pile up.
  const unused = contract.exceptions.filter(e => !used.has(e)).map(({ fileRe, importRe, ...e }) => e);
  return { files: checked, violations, excepted, unusedExceptions: unused };
}

const key = exception => `${exception.file} -> ${exception.import}`;

/**
 * The ways `current` loosens `base` (both contract objects): what a reviewer must approve. Tightening
 * (a new denied package, a narrower allow list, a removed exception) is not listed.
 * @returns {string[]}
 */
export function contractLoosening(base, current) {
  const changes = [];
  const modules = new Set([...Object.keys(base.modules ?? {}), ...Object.keys(current.modules ?? {})]);
  for (const name of modules) {
    const before = JSON.stringify([...(base.modules?.[name] ?? [])].sort());
    const after = JSON.stringify([...(current.modules?.[name] ?? [])].sort());
    if (base.modules?.[name] && before !== after) changes.push(`modules.${name} changed from ${before} to ${after}: files may have left the module`);
  }
  for (const [name, targets] of Object.entries(base.allow ?? {})) {
    if (!Object.hasOwn(current.allow ?? {}, name)) { changes.push(`allow.${name} was removed: ${name} may now import any module`); continue; }
    for (const target of current.allow[name]) if (!targets.includes(target)) changes.push(`allow.${name} adds ${target}`);
  }
  for (const [name, packages] of Object.entries(base.denyPackages ?? {})) {
    for (const pkg of packages) if (!(current.denyPackages?.[name] ?? []).includes(pkg)) changes.push(`denyPackages.${name} no longer denies ${pkg}`);
  }
  for (const glob of current.ignore ?? []) if (!(base.ignore ?? []).includes(glob)) changes.push(`ignore adds ${glob}`);
  const before = new Map((base.exceptions ?? []).map(e => [key(e), e]));
  for (const exception of current.exceptions ?? []) {
    const old = before.get(key(exception));
    if (!old) changes.push(`exception added: ${key(exception)} (${exception.reason}; approved by ${exception.approvedBy}${exception.expires ? `; expires ${exception.expires}` : ''})`);
    else if (old.reason !== exception.reason || old.approvedBy !== exception.approvedBy || (old.expires ?? '') !== (exception.expires ?? '')) changes.push(`exception changed: ${key(exception)} (now ${exception.reason}; approved by ${exception.approvedBy}${exception.expires ? `; expires ${exception.expires}` : '; no expiry'})`);
  }
  return changes;
}

/** The contract as git has it at `ref`, or undefined when it did not exist there. */
async function contractAt(root, ref, relative) {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', root, 'show', `${ref}:${relative}`], { maxBuffer: 4 * 1024 * 1024 });
    try { return JSON.parse(stdout); } catch (error) { throw new ContractError(`${relative} at ${ref}: ${error.message}`); }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (/exists on disk, but not in|does not exist in|path .* does not exist/.test(String(error.stderr ?? ''))) return undefined;
    throw new ContractError(`cannot read ${relative} at ${ref}: ${String(error.stderr ?? error.message).trim()}`);
  }
}

async function main(argv) {
  const VALUED = ['--root', '--contract', '--base', '--approved-by'];
  const arg = name => { const at = argv.indexOf(name); if (at < 0) return undefined; const value = argv[at + 1]; if (value === undefined || value.startsWith('--')) throw new ContractError(`${name} needs a value`); return value; };
  const unknown = argv.filter((a, i) => (a.startsWith('--') && !['--json', ...VALUED].includes(a)) || (!a.startsWith('--') && !VALUED.includes(argv[i - 1])));
  if (unknown.length) throw new ContractError(`unknown argument ${unknown[0]}; use --root DIR, --contract FILE, --base GIT-REF, --approved-by NAME, --json`);
  if (argv.includes('--approved-by') && !argv.includes('--base')) throw new ContractError('--approved-by acknowledges contract changes found with --base');
  const root = path.resolve(arg('--root') ?? process.cwd());
  const contractFile = path.resolve(root, arg('--contract') ?? 'docs/architecture/contract.json');
  let text;
  try { text = await readFile(contractFile, 'utf8'); }
  catch { throw new ContractError(`no contract at ${contractFile}; write one (see references/architecture-contract.md) or pass --contract`); }
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new ContractError(`${contractFile}: ${error.message}`); }
  const result = await checkBoundaries(root, value);
  const relative = toPosix(path.relative(root, contractFile));
  // A weaker contract makes the check pass too: with --base, loosening it needs an acknowledged review.
  const base = arg('--base');
  const approvedBy = arg('--approved-by');
  let contractChanges = [];
  if (base) {
    const before = await contractAt(root, base, relative);
    contractChanges = before === undefined ? [] : contractLoosening(before, value);
  }
  const unreviewed = contractChanges.length && !approvedBy;
  if (argv.includes('--json')) console.log(JSON.stringify({ contract: relative, ...result, ...(base ? { base, contractChanges, ...(approvedBy ? { approvedBy } : {}) } : {}) }, null, 2));
  else {
    for (const v of result.violations) console.log(`${v.file}:${v.line}  ${v.from} -> ${v.to} (${v.specifier}): ${v.rule}`);
    for (const e of result.excepted) console.log(`${e.file}:${e.line}  ${e.from} -> ${e.to}: allowed by exception (${e.reason}; approved by ${e.approvedBy}${e.expires ? `; expires ${e.expires}` : ''})`);
    for (const e of result.unusedExceptions) console.log(`unused exception: ${key(e)} (${e.reason}; approved by ${e.approvedBy}): nothing needs it; remove it`);
    for (const change of contractChanges) console.log(`contract change since ${base}${approvedBy ? `, approved by ${approvedBy}` : ', needs review'}: ${change}`);
    console.log(`${result.files} file(s) checked against ${relative}: ${result.violations.length} violation(s), ${result.excepted.length} by exception${base ? `, ${contractChanges.length} contract change(s) since ${base}${unreviewed ? ' not reviewed' : ''}` : ''}`);
    if (unreviewed) console.log('A loosened contract is a decision for the owner of these rules: get it reviewed, then run with --approved-by NAME to record who approved it. Do not edit the contract to make a check pass.');
  }
  return result.violations.length || unreviewed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-boundaries.mjs')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof ContractError ? `check-boundaries: ${error.message}` : error);
    process.exitCode = 2;
  });
}
