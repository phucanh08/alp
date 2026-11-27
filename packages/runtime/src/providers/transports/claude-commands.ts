import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The plugin name ALP's skills are loaded under, so Claude Code calls them alp:<name>. */
export const SKILL_PLUGIN = 'alp';
/** Claude's /clear and its aliases (supportedCommands reports `clear [reset, new]`): each starts a new conversation. */
const NEW_CONVERSATION_COMMANDS = ['clear', 'reset', 'new'];
const NEW_CONVERSATION = new RegExp(`^\\s*\\/(${NEW_CONVERSATION_COMMANDS.join('|')})(?:\\s|$)`);
/** Claude's own commands the composer does not offer: ALP does their work its own way (t-efa3). */
export const ALP_HANDLED_COMMANDS = new Set([...NEW_CONVERSATION_COMMANDS, 'compact', 'rewind']);
/** The aliases of /clear a command of the user's may take as its own name. */
const CLEAR_ALIASES = new Set(['reset', 'new']);

type ListedCommand = { name?: unknown; builtin?: unknown };
/**
 * t-5ac5: the aliases of /clear (new, reset) that, in this listing, run a command of the user's,
 * project, plugin or MCP server rather than Claude's /clear. The SDK marks Claude's own rows
 * `builtin: true`; a marked row wins its name, and an alias runs a command that has it as its name
 * (SlashCommand.builtin). So /new is the user's when an unmarked row is named new and no marked row is.
 * A listing without the marker (an older Claude Code) cannot tell the two apart: nothing is the
 * user's then, and ALP keeps refusing /new and /reset, since letting Claude's /clear through loses the
 * conversation while refusing a custom command only costs the user its name. /clear itself is always
 * Claude's: a marked row is named clear.
 */
export function customClearAliases(listed: ReadonlyArray<ListedCommand> | undefined): Set<string> {
  const rows = Array.isArray(listed) ? listed : [];
  if (!rows.some(row => typeof row?.builtin === 'boolean')) return new Set();
  const builtin = new Set(rows.filter(row => row?.builtin === true).map(row => row.name));
  return new Set(rows.filter(row => row?.builtin !== true && typeof row?.name === 'string' && CLEAR_ALIASES.has(row.name) && !builtin.has(row.name)).map(row => row.name as string));
}

/**
 * t-e906: Claude's /clear moves it to a new conversation under a new session id while ALP keeps the
 * old thread, so resume, fork and rewind would point at the conversation from before. ALP refuses it
 * rather than follow: its timeline, turn ids and rewinds belong to the old conversation. /reset and /new are
 * the same command, unless the session lists a command of the user's under that name (`custom`,
 * from customClearAliases).
 */
export function nativeCommandRefusal(runtimeKind: string, content: ReadonlyArray<{ type: string; text?: string }>, custom?: ReadonlySet<string>) {
  if (runtimeKind !== 'claude') return undefined;
  // The text Claude gets: every text part, joined as startPrompt joins them.
  const typed = content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
  const named = NEW_CONVERSATION.exec(typed)?.[1];
  if (!named || custom?.has(named)) return undefined;
  return 'ALP does not pass /clear (or /new, /reset) to Claude: Claude would start a new conversation that this session does not follow. Start a new session in ALP for a fresh conversation, or compact this one (alp compact, or Compact in the app).';
}

/**
 * A Claude Code plugin in `directory` holding the given skills, linked to their own
 * directories so an edit to a skill reaches the next session (ALPD §59).
 */
export function skillPlugin(directory: string, skills: Array<{ name: string; path: string }>) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(directory, 'skills'));
  writeFileSync(path.join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: SKILL_PLUGIN, description: "The agent's ALP skills" }));
  for (const skill of skills) symlinkSync(path.dirname(skill.path), path.join(directory, 'skills', skill.name), 'dir');
  return directory;
}
