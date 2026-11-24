/**
 * How a native provider's command is started on Windows, never through a shell (t-1a70, issue #236).
 *
 * `npm install -g @openai/codex` puts no codex.exe on PATH. It writes three launchers into the npm
 * prefix: `codex` (sh), `codex.cmd` and `codex.ps1`. A spawn without a shell looks a bare name up with
 * `.com` and `.exe` only, so `spawn('codex')` ends in ENOENT, and Node refuses to start a `.cmd`
 * without a shell at all (the CVE-2024-27980 fix). Running the launcher through cmd.exe would hand
 * every argument to cmd's parser; ALP does not do that.
 *
 * Instead the launcher is READ. npm's cmd-shim writes one fixed batch file (the same text from
 * cmd-shim 4.1.0 to 8.0.0, npm 7 to 11) whose last line names what it runs:
 *
 *   "%_prog%" [node flags] "%dp0%\node_modules\<package>\<script>" %*     a Node script
 *   "%dp0%\node_modules\<package>\<file>.exe"   %*                         a native executable
 *
 * and that target is started directly: the script under ALP's own Node, the executable as it is.
 * The caller appends its arguments to the returned array, so they reach the provider unchanged.
 *
 * What is accepted, and nothing else:
 * - the whole file must be that template, line for line; a hand-written batch file, a launcher
 *   with extra commands, one that sets variables, or another package manager's launcher is refused;
 * - the interpreter must be `node`; flags must look like flags (`--name[=value]`, no path in the value);
 * - the target must lie inside `node_modules` beside the launcher: no `..`, no drive, no absolute
 *   path (the check is on the path's text; a junction npm made inside node_modules is followed);
 * - a bare name is looked up in the absolute directories of PATH only, never in the working
 *   directory, and the first directory that has the name decides: a launcher that is refused there
 *   is an error, not a reason to look further down PATH.
 *
 * A refusal says which file, why, and how to install or configure the provider. Outside Windows a
 * command is returned as it is.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { scriptCommand } from '@anhlp/alp-core/packaged';

export type ProviderLaunch = { command: string; args: string[]; env?: Record<string, string> };

/** What an error calls the provider, the variable that names its executable, and how it is installed. */
export type ProviderNames = { label: string; variable: string; install: string; native: string };

export const CODEX_COMMAND: ProviderNames = { label: 'Codex', variable: 'ALP_CODEX_BIN', install: 'npm install -g @openai/codex', native: 'codex.exe' };

/** The platform and file system the lookup runs against; tests pass their own. */
export type CommandHost = {
  platform: NodeJS.Platform;
  /** The environment of this process: where PATH is read when the child's environment has none, as spawn does. */
  parentEnv: Record<string, string | undefined>;
  /** Whether `file` exists and is not a directory. */
  isFile(file: string): boolean;
  read(file: string): string;
  /** The command that runs a JavaScript file under ALP's Node. */
  script(file: string): ProviderLaunch;
};

const HOST: CommandHost = {
  get platform() { return process.platform; },
  get parentEnv() { return process.env; },
  isFile(file) {
    try { return statSync(file).isFile(); } catch {}
    // An entry stat cannot follow (an app execution alias) is still a file spawn can start.
    try { return !lstatSync(file).isDirectory(); } catch { return false; }
  },
  read: file => readFileSync(file, 'utf8'),
  script: file => scriptCommand(file),
};

const win = path.win32;
const LAUNCHER = /\.(cmd|bat|ps1)$/i;
const SCRIPT = /\.[cm]?js$/i;

// npm's cmd-shim (lib/index.js, writeShim_), unchanged from 4.1.0 to 8.0.0.
const HEAD = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0'];
const NODE = ['', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', ''];
const RUN = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ';
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9_.,:=+@-]*$/;

export type NpmShim = { kind: 'script'; flags: string[]; target: string } | { kind: 'native'; target: string } | { refused: string };

/** The target inside node_modules, as the launcher writes it, or why it is not one. */
function shimTarget(target: string): string | undefined {
  const parts = target.split('\\');
  if (parts[0] !== 'node_modules' || parts.length < 3) return `runs ${target}, which is not inside the node_modules directory beside it`;
  // No way out of that directory, and no name cmd or Windows would read differently from Node.
  if (parts.some(part => !part || part === '.' || part === '..' || /[/:*?"<>|%^&\x00-\x1f]/.test(part))) return `runs ${target}, which is not a plain path inside the node_modules directory beside it`;
  return undefined;
}

/**
 * Reads the text of a `.cmd` launcher: what npm's launcher runs, relative to the launcher's
 * directory, or `refused` with the reason when the file is anything but npm's template.
 */
export function readNpmShim(text: string): NpmShim {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const other = { refused: 'is not the launcher npm writes' };
  if (lines.length <= HEAD.length || HEAD.some((line, index) => lines[index] !== line)) return other;
  const rest = lines.slice(HEAD.length);
  if (rest.length === 1) {
    const native = /^"%dp0%\\([^"]+)"   %\*$/.exec(rest[0]);
    if (!native) return other;
    const problem = shimTarget(native[1]);
    if (problem) return { refused: problem };
    if (!/\.(exe|com)$/i.test(native[1])) return { refused: `runs ${native[1]} with whatever Windows associates with that file type, not with Node` };
    return { kind: 'native', target: native[1] };
  }
  if (rest.length !== NODE.length + 1 || NODE.some((line, index) => rest[index] !== line)) {
    // The same template around another interpreter, or with variables set before it runs.
    return /SET "_prog=/.test(text) ? { refused: 'is an npm launcher for something other than a plain Node script (another interpreter, or variables set before it runs)' } : other;
  }
  const last = rest[NODE.length];
  const run = last.startsWith(RUN) ? /^(.*) "%dp0%\\([^"]+)" %\*$/.exec(last.slice(RUN.length)) : null;
  if (!run) return other;
  const flags = run[1] ? run[1].split(' ') : [];
  const bad = flags.find(flag => !FLAG.test(flag));
  if (bad !== undefined) return { refused: `passes ${JSON.stringify(bad)} to Node, which is not a plain flag` };
  const problem = shimTarget(run[2]);
  if (problem) return { refused: problem };
  return { kind: 'script', flags, target: run[2] };
}

/** PATH as a spawn without a shell reads it: from the child's environment, else from this process's. */
function pathDirectories(env: Record<string, string | undefined>, host: CommandHost): string[] {
  const value = (source: Record<string, string | undefined>) => {
    // Windows names are case-insensitive; of several spellings the first in sort order wins, as in child_process.
    const key = Object.keys(source).filter(name => name.toUpperCase() === 'PATH').sort()[0];
    return key === undefined ? undefined : source[key];
  };
  return (value(env) ?? value(host.parentEnv) ?? '').split(';')
    .map(directory => directory.trim().replace(/^"(.*)"$/, '$1'))
    // A relative entry means "under the working directory": a project must not be able to supply the provider.
    .filter(directory => directory && win.isAbsolute(directory));
}

function refusal(names: ProviderNames, file: string, why: string): Error {
  return new Error(`${names.label}: ${file} ${why}. ALP starts ${names.label} without a shell, so the only launcher it follows is the one npm writes. Install ${names.label} with \`${names.install}\`, or set ${names.variable} to the full path of the native ${names.native} or of the JavaScript file the launcher runs.`);
}

/** What the npm launcher `file` runs, or the refusal. */
function fromShim(file: string, names: ProviderNames, host: CommandHost): ProviderLaunch {
  let text: string;
  try { text = host.read(file); } catch (error) { throw refusal(names, file, `cannot be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'})`); }
  const shim = readNpmShim(text);
  if ('refused' in shim) throw refusal(names, file, shim.refused);
  const target = win.join(win.dirname(file), shim.target);
  if (!host.isFile(target)) throw refusal(names, file, `runs ${target}, which does not exist (a broken or half-removed install)`);
  if (shim.kind === 'native') return { command: target, args: [] };
  const run = host.script(target);
  return { command: run.command, args: [...shim.flags, ...run.args], ...(run.env ? { env: run.env } : {}) };
}

/**
 * The command and leading arguments that start `command` for a provider; the caller appends its own
 * arguments. On Windows a bare name is found on PATH (`.com`, `.exe`, then npm's `.cmd` launcher),
 * and a launcher is replaced by what it runs; see the note at the top of this file. Throws when the
 * command is a launcher ALP will not follow, or a bare name that PATH does not have.
 */
export function providerLaunch(command: string, env: Record<string, string | undefined>, names: ProviderNames, host: CommandHost = HOST): ProviderLaunch {
  if (host.platform !== 'win32') {
    if (LAUNCHER.test(command)) throw new Error(`${names.label} executable must be a native binary, not a shell launcher`);
    return { command, args: [] };
  }
  const extension = win.extname(command).toLowerCase();
  const named = /[\\/:]/.test(command);
  // Windows cannot exec a script by its shebang: a JavaScript command (the fake Codex of the tests, or the file a launcher runs) runs under ALP's Node.
  if (SCRIPT.test(command)) return host.script(command);
  if (extension === '.ps1') throw refusal(names, command, 'is a PowerShell script');
  if (extension === '.cmd' || extension === '.bat') {
    // The configured launcher itself, or nothing: never another file of that name somewhere else.
    if (named && !win.isAbsolute(command)) throw refusal(names, command, 'is a launcher named by a relative path, which would depend on the working directory');
    const file = named ? command : pathDirectories(env, host).map(directory => win.join(directory, command)).find(candidate => host.isFile(candidate));
    if (!file) throw refusal(names, command, 'is not in any directory of PATH');
    if (!host.isFile(file)) throw refusal(names, file, 'does not exist');
    return fromShim(file, names, host);
  }
  if (named) {
    // `where codex` prints npm's sh launcher first (…\npm\codex): the .cmd beside it is the one for Windows.
    if (!extension && win.isAbsolute(command) && !['.com', '.exe'].some(suffix => host.isFile(command + suffix)) && host.isFile(`${command}.cmd`)) return fromShim(`${command}.cmd`, names, host);
    return { command, args: [] };
  }
  // A bare name: the first PATH directory that has it decides. Spawn would also look in the working directory first; ALP does not.
  const natives = extension ? [command] : [`${command}.com`, `${command}.exe`];
  for (const directory of pathDirectories(env, host)) {
    const native = natives.map(name => win.join(directory, name)).find(candidate => host.isFile(candidate));
    if (native) return { command: native, args: [] };
    const shim = win.join(directory, `${command}.cmd`);
    if (!extension && host.isFile(shim)) return fromShim(shim, names, host);
  }
  throw new Error(`${names.label} was not found: ${extension ? `no ${command}` : `no ${command}.exe and no npm launcher ${command}.cmd`} in any directory of PATH. Install ${names.label} with \`${names.install}\`, or set ${names.variable} to the full path of the native ${names.native}.`);
}
