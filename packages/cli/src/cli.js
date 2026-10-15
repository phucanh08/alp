#!/usr/bin/env node
import { setup } from '@anhlp/alp-client/setup';
import { alpHome } from '@anhlp/alp-client/index';
import { scrubText } from '@anhlp/alp-core/log';
import { USAGE, UsageError } from './usage.js';
import { project, permissionsCommand, trustCommand, language, verify, doctor } from './projects.js';
import { daemon } from './daemon.js';
import { run, ps, attach, send, questions, answer, top, log, board, pause, resume, recall, interrupt } from './sessions.js';
import { libraryCommand, editCommand, teamsCommand } from './library.js';
import { tasksCommand, formulaCommand, taskCommand } from './tasks.js';
import { webCommand, acpCommand } from './interfaces.js';
import { backupCommand, restoreCommand } from './backup.js';

const commands = { setup: args => setup(args, alpHome()), init: args => project('init', args), upgrade: args => project('upgrade', args), update: args => project('upgrade', args), daemon, doctor, run, ps, top, attach, send, questions, answer, log, board, tasks: tasksCommand, task: taskCommand, formula: formulaCommand, permissions: permissionsCommand, agents: args => libraryCommand('agents', args), skills: args => libraryCommand('skills', args), mcp: args => ['add', 'rm', 'mv', 'cp', 'test', 'show', 'edit'].includes(args[0]) ? editCommand('mcp', args) : libraryCommand('mcp', args), hooks: args => libraryCommand('hooks', args), providers: args => libraryCommand('providers', args), provider: args => editCommand('providers', args), teams: teamsCommand, trust: trustCommand, agent: args => editCommand('agents', args), team: args => editCommand('teams', args), skill: args => editCommand('skills', args), hook: args => editCommand('hooks', args), verify, recall, pause, resume, language, interrupt, acp: acpCommand, web: webCommand, backup: backupCommand, restore: restoreCommand };
const [command, ...args] = process.argv.slice(2);
try {
  if (!Object.hasOwn(commands, command)) throw new UsageError();
  await commands[command](args);
} catch (error) {
  if (error instanceof UsageError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(USAGE);
  else console.error(`alp: ${scrubText(error?.message ?? error)}`);
  process.exitCode = 1;
}
