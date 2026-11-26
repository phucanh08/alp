#!/usr/bin/env node
// The `alp` executable: reads argv, answers --version, dispatches a command to its handler and
// reports what it throws. Every handler lives under commands/<group>/, named after the command;
// commands/_shared holds what several groups use (usage text, the --project lookup, role scripts).
import { setup } from '@anhlp/alp-client/setup';
import { alpHome } from '@anhlp/alp-client/index';
import { scrubText } from '@anhlp/alp-core/log';
import { catalogModels, useLiveModels } from '@anhlp/alp-core/models';
import { USAGE, UsageError } from './commands/_shared/usage.ts';
import { alpVersion } from './version.ts';
// session: work with alpd's sessions.
import { run } from './commands/session/run.ts';
import { ps } from './commands/session/ps.ts';
import { top } from './commands/session/top.ts';
import { attach } from './commands/session/attach.ts';
import { send } from './commands/session/send.ts';
import { questions, answer } from './commands/session/questions.ts';
import { log } from './commands/session/log.ts';
import { board } from './commands/session/board.ts';
import { models } from './commands/session/models.ts';
import { pause, resume } from './commands/session/pause.ts';
import { recall } from './commands/session/recall.ts';
import { interrupt } from './commands/session/interrupt.ts';
import { compact } from './commands/session/compact.ts';
// project: the ALP project in a directory.
import { project } from './commands/project/init.ts';
import { permissionsCommand } from './commands/project/permissions.ts';
import { trustCommand } from './commands/project/trust.ts';
import { language } from './commands/project/language.ts';
import { verify } from './commands/project/verify.ts';
import { doctor } from './commands/project/doctor.ts';
import { configCommand } from './commands/project/config.ts';
// task: the project's task graph and formulas.
import { tasksCommand } from './commands/task/tasks.ts';
import { taskCommand } from './commands/task/task.ts';
import { formulaCommand } from './commands/task/formula.ts';
// library: agents, teams, skills, MCP servers, hooks, providers and packs.
import { libraryCommand } from './commands/library/list.ts';
import { editCommand } from './commands/library/edit.ts';
import { teamsCommand } from './commands/library/teams.ts';
import { packsCommand, packCommand } from './commands/library/packs.ts';
// The other groups have one entry each.
import { daemon } from './commands/daemon/index.ts';
import { scheduleCommand } from './commands/schedule/index.ts';
import { dashboardCommand } from './commands/dashboard/index.ts';
import { acpCommand } from './commands/acp/index.ts';
import { desktopCommand } from './commands/desktop/index.ts';
import { terminalCommand } from './commands/terminal/index.ts';
import { backupCommand, restoreCommand } from './commands/backup/index.ts';
import { bridgeCommand } from './commands/bridge/index.ts';
import { updateCommand } from './commands/update/index.ts';

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
