// The library group as the package's `./library` subpath exports it: list.ts lists a kind (alp agents,
// skills, mcp, hooks, providers), edit.ts edits one entry (alp agent, team, skill, mcp <action>, hook,
// provider), teams.ts and packs.ts serve alp teams, packs and pack.
export { projectFlag } from '../_shared/project.js';
export { libraryCommand } from './list.js';
export { pairs, names, EDIT_OPTIONS, edited, editCommand } from './edit.js';
export { teamsCommand } from './teams.js';
export { packsCommand, packCommand } from './packs.js';
