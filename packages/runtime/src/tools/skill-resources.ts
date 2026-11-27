import path from 'node:path';
import { simpleCommands, unwrapShell } from '@anhlp/alp-core/permissions';

/**
 * Progressive-disclosure evidence (skill system v2): which of an agent's skill resources (files under
 * references/, scripts/, assets/, templates/, data/) a tool call reads or runs. Only what the agent
 * asked for counts, never what a tool printed, and only reading or running: writing a skill file,
 * listing a directory or naming a path in some other command is not "opening it on demand".
 *
 * Every runtime reports a call as a command line (claude-transport, acp-transport, Codex):
 * - a shell command (Bash, Codex, an ACP `execute`), possibly wrapped in `sh -c '…'`;
 * - Claude's other tools as `Name {json input}`;
 * - an ACP agent's other tools as `kind: title`.
 */
export type ResourceAction = 'read' | 'run';
export type ResourceUse = { skill: string; resource: string; action: ResourceAction };

const RESOURCE = '(?:references|scripts|assets|templates|data)/[\\w.@+-]+(?:/[\\w.@+-]+)*';
/** Programs that run their first file argument. */
const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'dash', 'ruby', 'perl', 'pwsh', 'powershell']);
/** Programs that read their file arguments. */
const READERS = new Set(['cat', 'bat', 'less', 'more', 'head', 'tail', 'sed', 'awk', 'grep', 'rg', 'egrep', 'nl', 'wc', 'cut', 'sort', 'jq', 'diff', 'view', 'type', 'get-content']);
/** Words before the program that do not change what runs. */
const PREFIXES = new Set(['sudo', 'env', 'exec', 'time', 'command', 'nice', 'nohup']);
/** Claude tools that read the file they name, and the input fields that name it. */
const CLAUDE_READERS: Record<string, string[]> = { Read: ['file_path', 'path'], NotebookRead: ['notebook_path'], Grep: ['path'] };

const slash = (value: string) => value.replace(/\\\\/g, '/').replace(/\\/g, '/');
const words = (command: string) => [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);

/** Each path a command reads or runs, with what it does to it. */
export function pathActions(command: string): Array<{ file: string; action: ResourceAction }> {
  const claude = /^([A-Z][A-Za-z]+) (\{[\s\S]*\})$/.exec(command);
  if (claude) {
    const fields = CLAUDE_READERS[claude[1]];
    if (!fields) return [];
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(claude[2]); } catch { return []; }
    return fields.map(field => input[field]).filter((value): value is string => typeof value === 'string').map(file => ({ file, action: 'read' as const }));
  }
  const acp = /^(read|search|edit|delete|move|think|fetch|other): ([\s\S]*)$/.exec(command);
  if (acp) return acp[1] === 'read' ? words(acp[2]).map(file => ({ file, action: 'read' as const })) : [];
  const found: Array<{ file: string; action: ResourceAction }> = [];
  for (const simple of simpleCommands(unwrapShell(command)) ?? [command]) {
    const tokens = words(simple).filter(token => token !== undefined);
    while (tokens.length && (/^\w+=/.test(tokens[0]) || PREFIXES.has(tokens[0]))) tokens.shift();
    if (!tokens.length) continue;
    const program = path.posix.basename(slash(tokens[0])).toLowerCase().replace(/\.exe$/, '');
    const args = tokens.slice(1).filter(token => !token.startsWith('-'));
    if (new RegExp(`/${RESOURCE}$`).test(slash(tokens[0]))) found.push({ file: tokens[0], action: 'run' });
    else if (INTERPRETERS.has(program)) args.forEach((file, index) => found.push({ file, action: index === 0 ? 'run' : 'read' }));
    else if (READERS.has(program)) args.forEach(file => found.push({ file, action: 'read' }));
  }
  return found;
}

/**
 * The resources of `skills` a command reads or runs: by the skill's own directory, or by Claude's
 * plugin link to it (`<plugin>/skills/<name>/…`). A path in another skill directory is not this agent's.
 */
export function resourceUses(command: string, skills: Array<{ name: string; path: string }>): ResourceUse[] {
  if (!command || !slash(command).includes('/skills/')) return [];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uses: ResourceUse[] = [];
  for (const { file, action } of pathActions(command)) {
    const normal = slash(file);
    for (const skill of skills) {
      const match = new RegExp(`(?:^|/)(?:${escape(slash(path.dirname(skill.path)).replace(/^\//, ''))}|skills/${escape(skill.name)})/(${RESOURCE})$`).exec(normal.replace(/^\//, ''));
      if (match) uses.push({ skill: skill.name, resource: match[1], action });
    }
  }
  return uses;
}
