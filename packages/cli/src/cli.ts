#!/usr/bin/env node
// The `alp` executable: reads argv, answers --version, dispatches a command to its handler and
// reports what it throws. Every handler lives under commands/<group>/, named after the command;
// commands/_shared holds what several groups use (usage text, the --project lookup, role scripts).
import { setup } from '@anhlp/alp-client/setup';
import { alpHome } from '@anhlp/alp-client/index';
import { scrubText } from '@anhlp/alp-core/log';
import { catalogModels, useLiveModels } from '@anhlp/alp-core/models';
import { USAGE, UsageError } from './commands/_shared/usage.js';
import { alpVersion } from './version.js';
// session: work with alpd's sessions.
import { run } from './commands/session/run.js';
import { ps } from './commands/session/ps.js';
import { top } from './commands/session/top.js';
import { attach } from './commands/session/attach.js';
import { send } from './commands/session/send.js';
import { questions, answer } from './commands/session/questions.js';
import { log } from './commands/session/log.js';
import { board } from './commands/session/board.js';
import { models } from './commands/session/models.js';
import { pause, resume } from './commands/session/pause.js';
import { recall } from './commands/session/recall.js';
import { interrupt } from './commands/session/interrupt.js';
import { compact } from './commands/session/compact.js';
// project: the ALP project in a directory.
import { project } from './commands/project/init.js';
import { permissionsCommand } from './commands/project/permissions.js';
import { trustCommand } from './commands/project/trust.js';
import { language } from './commands/project/language.js';
import { verify } from './commands/project/verify.js';
import { doctor } from './commands/project/doctor.js';
import { configCommand } from './commands/project/config.js';
// task: the project's task graph and formulas.
import { tasksCommand } from './commands/task/tasks.js';
import { taskCommand } from './commands/task/task.js';
import { formulaCommand } from './commands/task/formula.js';
// library: agents, teams, skills, MCP servers, hooks, providers and packs.
import { libraryCommand } from './commands/library/list.js';
import { editCommand } from './commands/library/edit.js';
import { teamsCommand } from './commands/library/teams.js';
import { packsCommand, packCommand } from './commands/library/packs.js';
// The other groups have one entry each.
import { daemon } from './commands/daemon/index.js';
import { scheduleCommand } from './commands/schedule/index.js';
import { dashboardCommand } from './commands/dashboard/index.js';
import { acpCommand } from './commands/acp/index.js';
import { desktopCommand } from './commands/desktop/index.js';
import { terminalCommand } from './commands/terminal/index.js';
import { backupCommand, restoreCommand } from './commands/backup/index.js';
import { bridgeCommand } from './commands/bridge/index.js';
import { updateCommand } from './commands/update/index.js';

/** `alp mcp <action>` edits an MCP server entry; `alp mcp` with anything else lists them. */
const MCP_EDIT_ACTIONS = ['add', 'rm', 'mv', 'cp', 'test', 'show', 'edit'];

/** Command name → handler. The plural library commands list a kind; the singular ones edit one entry. */
const commands: Record<string, (args: string[]) => unknown> = {
  // session
  run, ps, top, attach, send, questions, answer, log, board, models, pause, resume, recall, interrupt, compact,
  // project; `setup` writes profiles before any catalog exists, so it is the one command that skips useLiveModels below.
  setup: args => setup(args, alpHome()),
  init: args => project('init', args),
  'update-template': args => project('upgrade', args),
  upgrade: args => project('upgrade', args), // alias of update-template
  permissions: permissionsCommand, trust: trustCommand, language, verify, doctor, config: configCommand,
  // task
  tasks: tasksCommand, task: taskCommand, formula: formulaCommand,
  // library
  agents: args => libraryCommand('agents', args),
  skills: args => libraryCommand('skills', args),
  mcp: args => MCP_EDIT_ACTIONS.includes(args[0]) ? editCommand('mcp', args) : libraryCommand('mcp', args),
  hooks: args => libraryCommand('hooks', args),
  providers: args => libraryCommand('providers', args),
  provider: args => editCommand('providers', args),
  agent: args => editCommand('agents', args),
  team: args => editCommand('teams', args),
  skill: args => editCommand('skills', args),
  hook: args => editCommand('hooks', args),
  teams: teamsCommand, packs: packsCommand, pack: packCommand,
  // one-file groups
  daemon,
  schedule: scheduleCommand,
  dashboard: dashboardCommand,
  acp: acpCommand,
  desktop: desktopCommand,
  terminal: terminalCommand,
  backup: backupCommand, restore: restoreCommand,
  bridge: bridgeCommand,
  update: updateCommand,
};

const [command, ...args] = process.argv.slice(2);
try {
  if (command === '--version') {
    // Published builds inject their package version; source execution reads the same metadata.
    console.log(alpVersion());
  } else {
    if (!Object.hasOwn(commands, command)) throw new UsageError();
    // Effort checks read the catalog alpd last cached, the rows alpd itself checks with (t-086c), so
    // the CLI and alpd agree on a model only live rows list (t-b3cd #8). No provider is asked.
    if (command !== 'setup') useLiveModels(catalogModels(alpHome()));
    await commands[command as string](args);
  }
} catch (error) {
  if (error instanceof UsageError || (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(USAGE);
  else console.error(`alp: ${scrubText((error as Error | undefined)?.message ?? error)}`);
  process.exitCode = 1;
}
