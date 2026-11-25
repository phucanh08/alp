/**
 * The composer's "/" suggestions (t-f628): while the box holds only "/" and a word, every slash
 * command and skill of the session (session.commands) whose name has that word, best first.
 */

export type SessionCommand = import('@anhlp/alp-protocol').SessionCommand;

/**
 * The word typed after a leading "/", or null when the box is not a command being typed (text
 * before the slash, or a space after the name).
 */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1] : null;
}

/**
 * The commands for `text`, or null outside a "/" word. A name that starts with the word comes
 * first, then one whose part after a colon starts with it (`alp:xia` for "xi"), then any other
 * that holds it; within each, the runtime's order (its commands, then the skills).
 */
export function matchCommands(commands: SessionCommand[], text: string): SessionCommand[] | null {
  const query = slashQuery(text);
  if (query === null) return null;
  const word = query.toLowerCase();
  const rank = (command: SessionCommand) => {
    const name = command.name.toLowerCase();
    if (name.startsWith(word)) return 0;
    if (name.slice(name.indexOf(':') + 1).startsWith(word)) return 1;
    return name.includes(word) ? 2 : -1;
  };
  return commands.map((command, index) => ({ command, index, rank: rank(command) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.command);
}

/** The box's text once `command` is chosen: its name and a space for its arguments. */
export const insertCommand = (command: SessionCommand) => `/${command.name} `;
