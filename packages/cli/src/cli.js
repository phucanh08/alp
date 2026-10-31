#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { setup } from '@anhlp/alp-client/setup';
import { alpHome } from '@anhlp/alp-client/index';
import { scrubText } from '@anhlp/alp-core/log';
import { USAGE, UsageError } from './usage.js';
import { project, permissionsCommand, trustCommand, language, verify, doctor } from './projects.js';
import { daemon } from './daemon.js';
import { run, ps, attach, send, questions, answer, top, log, board, models, pause, resume, recall, interrupt, compact } from './sessions.js';
import { libraryCommand, editCommand, teamsCommand } from './library.js';
import { scheduleCommand } from './schedules.js';
import { tasksCommand, formulaCommand, taskCommand } from './tasks.js';
import { webCommand, acpCommand } from './interfaces.js';
import { backupCommand, restoreCommand } from './backup.js';
import { terminalCommand } from './terminal.js';
import { bridgeCommand } from './roles.js';
import { selfUpdate } from './self-update.js';
import { bundleInfo } from '@anhlp/alp-core/packaged';
import { connect, lockAlive, readLock } from '@anhlp/alp-client/index';

/** The version of this alp: the build's, or the package's. */
function alpVersion() {
  /* global __ALP_VERSION__ */
  return (typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
}

/** The running alpd's version and live sessions, if one runs for this ALP_HOME. */
async function runningDaemon() {
  const lock = await readLock(alpHome());
  if (!lockAlive(lock)) return undefined;
  const client = await connect(lock.socket, { name: 'alp-cli', version: '1' }).catch(() => undefined);
  if (!client) return { version: lock.version };
  try {
    const status = await client.request('daemon.status');
    return { version: status.version ?? lock.version, sessions: status.sessions };
  } catch {
    return { version: lock.version };
  } finally {
    client.close();
  }
}

/** alp update: the bundle's self-update (t-1807); the template upgrade is alp update-template. */
async function updateCommand(args) {
  const code = await selfUpdate(args, { bundle: bundleInfo(), version: alpVersion(), daemon: runningDaemon });
  if (code) process.exitCode = code;
}

const commands = { schedule: scheduleCommand, setup: args => setup(args, alpHome()), init: args => project('init', args), 'update-template': args => project('upgrade', args), upgrade: args => project('upgrade', args), update: updateCommand, daemon, doctor, run, ps, top, attach, send, questions, answer, log, board, tasks: tasksCommand, task: taskCommand, formula: formulaCommand, permissions: permissionsCommand, agents: args => libraryCommand('agents', args), skills: args => libraryCommand('skills', args), mcp: args => ['add', 'rm', 'mv', 'cp', 'test', 'show', 'edit'].includes(args[0]) ? editCommand('mcp', args) : libraryCommand('mcp', args), hooks: args => libraryCommand('hooks', args), providers: args => libraryCommand('providers', args), provider: args => editCommand('providers', args), teams: teamsCommand, trust: trustCommand, agent: args => editCommand('agents', args), team: args => editCommand('teams', args), skill: args => editCommand('skills', args), hook: args => editCommand('hooks', args), verify, recall, pause, resume, language, models, interrupt, compact, acp: acpCommand, web: webCommand, backup: backupCommand, restore: restoreCommand, terminal: terminalCommand, bridge: bridgeCommand };
const [command, ...args] = process.argv.slice(2);
try {
  if (command === '--version') {
    // Published builds inject their package version; source execution reads the same metadata.
    console.log(alpVersion());
  } else {
    if (!Object.hasOwn(commands, command)) throw new UsageError();
    await commands[command](args);
  }
} catch (error) {
  if (error instanceof UsageError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(USAGE);
  else console.error(`alp: ${scrubText(error?.message ?? error)}`);
  process.exitCode = 1;
}
