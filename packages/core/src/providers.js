import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { settingsKeys, unknownMessage } from './validation.js';

/**
 * ACP providers (ALPD §46): agents that speak the Agent Client Protocol, such as Gemini
 * CLI or opencode, defined in the user's library as providers/<id>.json. An agent runs
 * on one with `provider: "<id>"` in its agent.json, or with the model `acp:<id>` or
 * `acp:<id>/<model>`. Providers live only in the library: a project's would run a
 * command from its repository on the user's machine.
 *
 *   { "kind": "acp", "label": "Gemini", "command": "gemini", "args": ["--experimental-acp"],
 *     "env": {}, "models": [{ "id": "gemini-2.5-pro" }] }
 *
 * The web app's Providers screen (ALPD §65) adds `enabled` (false turns it off), `additionalModels`
 * (added to the models the agent reports, where `models` replaces them) and `params`, which
 * Paseo's catalog carries and ALP keeps without using.
 */

export const PROVIDER_SETTINGS = ['$schema', 'kind', 'label', 'description', 'command', 'args', 'env', 'models', 'additionalModels', 'enabled', 'params', 'readOnlyMode'];
/** Runtimes ALP has built in; no provider takes their names. */
export const BUILTIN_RUNTIMES = ['codex', 'claude', 'acp', 'antigravity'];
/** Names no provider takes: the runtimes, and `alp`, which the web app lists ALP's teams under. */
export const RESERVED_PROVIDERS = [...BUILTIN_RUNTIMES, 'alp'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validId = id => typeof id === 'string' && /^[\w.-]+$/.test(id) && id !== '.' && id !== '..';

/** Checks a provider definition. */
export function validateProvider(config, source, id) {
  const check = (ok, message) => { if (!ok) throw new AlpError('INVALID_PROVIDER', `${source}: ${message}`); };
  if (id !== undefined) check(validId(id) && (!RESERVED_PROVIDERS.includes(id) || (id === 'antigravity' && config?.kind === 'antigravity')), `'${id}' cannot name a provider: ${RESERVED_PROVIDERS.join(', ')} are taken`);
  check(object(config), 'expected an object');
  const { unknown } = settingsKeys(config, PROVIDER_SETTINGS);
  check(!unknown.length, unknown.length ? unknownMessage(unknown[0], PROVIDER_SETTINGS) : '');
  check(['acp', 'antigravity'].includes(config.kind), 'kind must be "acp" or "antigravity"');
  if (config.kind === 'antigravity' && id !== undefined) check(id === 'antigravity', 'Antigravity must use provider ID antigravity');
  if (config.readOnlyMode !== undefined) check(config.kind === 'antigravity' && ['instructions', 'reject'].includes(config.readOnlyMode), 'readOnlyMode is only for Antigravity and must be "instructions" or "reject"');
  for (const key of ['label', 'description']) if (config[key] !== undefined) check(typeof config[key] === 'string', `${key} must be a string`);
  check(nonempty(config.command), 'command must be a nonempty string');
  if (config.args !== undefined) check(Array.isArray(config.args) && config.args.every(arg => typeof arg === 'string'), 'args must be a list of strings');
  if (config.env !== undefined) check(object(config.env) && Object.values(config.env).every(value => typeof value === 'string'), 'env must map names to strings');
  for (const key of ['models', 'additionalModels']) {
    if (config[key] === undefined) continue;
    check(Array.isArray(config[key]) && config[key].every(model => object(model) && nonempty(model.id) && !/\s/.test(model.id) &&
      Object.keys(model).every(field => ['id', 'label', 'description'].includes(field)) &&
      ['label', 'description'].every(field => model[field] === undefined || typeof model[field] === 'string')), `${key} must list { id, label?, description? }`);
    check(new Set(config[key].map(model => model.id)).size === config[key].length, `${key} lists an id twice`);
  }
  if (config.enabled !== undefined) check(typeof config.enabled === 'boolean', 'enabled must be true or false');
  if (config.params !== undefined) check(object(config.params), 'params must be an object');
  return config;
}

/**
 * A provider of the library, with its id; undefined when there is none.
 * @returns {Promise<{ id: string, kind: 'acp' | 'antigravity', label: string, description?: string, command: string, args: string[], env: Record<string, string>, models?: Array<{ id: string, label?: string, description?: string }>, additionalModels?: Array<{ id: string, label?: string, description?: string }>, enabled?: boolean, params?: Record<string, unknown>, readOnlyMode?: 'instructions' | 'reject' } | undefined>}
 */
export async function loadProvider(library, id) {
  if (!library || !validId(id) || (RESERVED_PROVIDERS.includes(id) && id !== 'antigravity')) return undefined;
  const file = path.join(library, 'providers', `${id}.json`);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let config;
  try { config = JSON.parse(text); } catch (cause) { throw new AlpError('INVALID_PROVIDER', `${file}: ${cause.message}`, { cause }); }
  validateProvider(config, file, id);
  // A relative command path is the provider file's; a bare name is looked up on PATH.
  const command = /[\\/]/.test(config.command) ? path.resolve(path.dirname(file), config.command) : config.command;
  return { id, ...config, label: config.label ?? id, command, args: config.args ?? [], env: config.env ?? {} };
}

/** Every provider of the library, by id. */
export async function listProviders(library) {
  if (!library) return [];
  let names = [];
  try { names = await readdir(path.join(library, 'providers')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const providers = [];
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const provider = await loadProvider(library, name.slice(0, -5));
    if (provider) providers.push(provider);
  }
  return providers;
}

/**
 * Splits an ACP model id, `<provider>` or `<provider>/<model>`, as resolveSession keeps it
 * after the `acp:` prefix.
 */
export function acpModel(model) {
  const slash = model.indexOf('/');
  return slash < 0 ? { provider: model, model: undefined } : { provider: model.slice(0, slash), model: model.slice(slash + 1) || undefined };
}

/**
 * How to start a command without a shell. On Windows a bare name installed with npm is a
 * `<name>.cmd` shim, which spawn refuses to run without one; its target runs instead: the
 * native executable it calls, or the Node script, under this Node. A bare name with an .exe or
 * .com on PATH, any other command, and every command elsewhere are returned as they are.
 * @param {string} command @param {string[]} [args] @param {Record<string, string | undefined>} [env]
 * @returns {{ command: string, args: string[] }}
 */
export function launchCommand(command, args = [], env = process.env) {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || path.extname(command)) return { command, args };
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  for (const directory of (key ? env[key] ?? '' : '').split(';').filter(Boolean)) {
    if (['.exe', '.com'].some(extension => existsSync(path.join(directory, command + extension)))) break;
    const shim = path.join(directory, `${command}.cmd`);
    if (!existsSync(shim)) continue;
    // npm's cmd-shim ends with `"%dp0%\<target>" %*`, or `"%_prog%" [node flags] "%dp0%\<script>" %*`
    // for a Node script. Anything else (a hand-written batch file) stays refused by spawn, as before.
    const text = readFileSync(shim, 'utf8');
    const script = /"%_prog%"((?:\s+[^\s"]+)*)\s+"%~?dp0%\\?([^"]+)"\s+%\*/i.exec(text);
    if (script) return { command: process.execPath, args: [...script[1].split(/\s+/).filter(Boolean), path.join(directory, script[2]), ...args] };
    const native = /^\s*"%~?dp0%\\?([^"]+\.(?:exe|com))"\s+%\*/im.exec(text);
    if (native) return { command: path.join(directory, native[1]), args };
    break;
  }
  return { command, args };
}
