#!/usr/bin/env node
// check-boundaries: checks a JavaScript/TypeScript repository's imports against its architecture
// contract (docs/architecture/contract.json by default). No dependencies, reads only, runs nothing.
//
//   node check-boundaries.mjs [--root DIR] [--contract FILE] [--json]
//
// Exit 0: no violations. Exit 1: violations (each printed as file:line). Exit 2: the contract or
// the arguments are invalid. The contract format is in ../references/architecture-contract.md.
import { readFile, readdir, stat } from 'node:fs/promises';
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
export async function checkBoundaries(root, contractValue) {
  const contract = parseContract(contractValue);
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
      if (exception) excepted.push({ ...finding, reason: exception.reason, approvedBy: exception.approvedBy });
      else violations.push(finding);
    }
  }
  return { files: checked, violations, excepted };
}

async function main(argv) {
  const arg = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const unknown = argv.filter((a, i) => a.startsWith('--') && !['--root', '--contract', '--json'].includes(a) && !['--root', '--contract'].includes(argv[i - 1]));
  if (unknown.length) throw new ContractError(`unknown option ${unknown[0]}; use --root DIR, --contract FILE, --json`);
  const root = path.resolve(arg('--root') ?? process.cwd());
  const contractFile = path.resolve(root, arg('--contract') ?? 'docs/architecture/contract.json');
  let text;
  try { text = await readFile(contractFile, 'utf8'); }
  catch { throw new ContractError(`no contract at ${contractFile}; write one (see references/architecture-contract.md) or pass --contract`); }
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new ContractError(`${contractFile}: ${error.message}`); }
  const result = await checkBoundaries(root, value);
  if (argv.includes('--json')) console.log(JSON.stringify({ contract: toPosix(path.relative(root, contractFile)), ...result }, null, 2));
  else {
    for (const v of result.violations) console.log(`${v.file}:${v.line}  ${v.from} -> ${v.to} (${v.specifier}): ${v.rule}`);
    for (const e of result.excepted) console.log(`${e.file}:${e.line}  ${e.from} -> ${e.to}: allowed by exception (${e.reason}; approved by ${e.approvedBy})`);
    console.log(`${result.files} file(s) checked against ${toPosix(path.relative(root, contractFile))}: ${result.violations.length} violation(s), ${result.excepted.length} by exception`);
  }
  return result.violations.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-boundaries.mjs')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof ContractError ? `check-boundaries: ${error.message}` : error);
    process.exitCode = 2;
  });
}
