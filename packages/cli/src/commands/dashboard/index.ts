import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { alpHome } from '@anhlp/alp-client/index';
import { isAgentProcess } from '@anhlp/alp-core/tasks';
import { scrubText } from '@anhlp/alp-core/log';
import { runRole } from '../_shared/run-role.ts';
import { UsageError } from '../_shared/usage.ts';
import { start } from '../daemon/index.ts';
import { DISABLED, PRINT_EXIT, PRINT_SCHEMA, PRINT_VERSION, addressOf, classed, dashboardDisabled, failure, reportMigration } from './common.ts';
import { migrateDashboard } from './migrate.ts';
import { pairCommand } from './pair.ts';
import { rotateCommand } from './rotate.ts';
import { serveDashboard } from './start.ts';
import { statusCommand, stopCommand } from './status.ts';
import { dashboardEntry, dashboardScript } from '../../dashboard-service.ts';

/** Loopback names `--host` accepts; the service listens on 127.0.0.1 only, which serves both. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

/** `alp dashboard` subcommands, which have their own arguments (and no --json). */
const DASHBOARD_SUBCOMMANDS = ['pair', 'rotate', 'serve'];

/**
 * alp dashboard. With --json (docs/alp/dashboard.md §3.3) stdout carries exactly one line, a JSON
 * object, on success and on every failure, and the exit code names the failure class. The token is
 * in that line only on success: it goes to the caller's stdout, as the address of --print does, and
 * nowhere else (no file, no argument, no log; --json never opens a browser).
 */
export async function dashboardCommand(args: string[]) {
  if (!args.includes('--json') || DASHBOARD_SUBCOMMANDS.includes(args[0])) return runDashboard(args);
  try {
    await runDashboard(args);
  } catch (error) {
    // any (three lines): whatever was thrown, read for an optional code, failure class or message.
    const usage = error instanceof UsageError || (error as any)?.code?.startsWith?.('ERR_PARSE_ARGS');
    const kind = usage ? 'usage' : Object.hasOwn(PRINT_EXIT, (error as any)?.kind) ? (error as any).kind as keyof typeof PRINT_EXIT : 'failed';
    const message = scrubText(String(error instanceof UsageError ? 'usage: alp dashboard [--port N] [--host 127.0.0.1|localhost] [--no-open|--print] [--json]' : (error as any)?.message ?? error));
    console.log(JSON.stringify({ schema: PRINT_SCHEMA, version: PRINT_VERSION, ok: false, error: { code: kind, message } }));
    console.error(`alp: ${message}`);
    process.exitCode = PRINT_EXIT[kind];
  }
}

async function runDashboard(args: string[]) {
  // alp dashboard prints, rotates and pairs with the user's own secrets (t-1c59), and stops the
  // user's service: a process an ALP agent started is refused before anything is read, stopped or printed.
  if (isAgentProcess()) throw failure('agent', 'alp dashboard is the user\'s: it prints and rotates the user\'s credential; this process was started by an ALP agent (ALP_AGENT_SESSION is set)');
  if (args[0] === 'pair') return pairCommand(args.slice(1));
  if (args[0] === 'rotate') return rotateCommand(args.slice(1));
  // alp-dashboard itself in this process; its own options (--service, --rotate, --project DIR, --port N) follow.
  if (args[0] === 'serve') return runRole('dashboard', dashboardScript(), args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    print: { type: 'boolean' }, 'no-open': { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'boolean' },
    port: { type: 'string' }, host: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (positionals.length) throw new UsageError();
  const home = alpHome();
  // As in Hermes, the lifecycle flags win over the start flags: they report or stop, and exit.
  if (values.status && values.stop) throw new UsageError();
  // --json is the contract of the address only; --status and --stop print text.
  if (values.json && (values.status || values.stop)) throw new UsageError();
  if (values.status) return statusCommand(home);
  if (values.stop) return stopCommand(home);
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1024 || port > 65535) throw failure('usage', `--port must be a port from 1024 to 65535, not ${values.port}`);
  }
  // ALP's token is the dashboard's only lock and its gateway accepts only loopback Host and Origin
  // names, so it is never bound beyond this machine (Hermes too refuses a non-loopback bind without
  // an auth provider, which ALP does not have).
  if (values.host !== undefined && !LOOPBACK_HOSTS.includes(values.host)) {
    throw failure('usage', `alp dashboard listens on this machine only (127.0.0.1): --host ${values.host} is refused. Reach it from another machine through an SSH tunnel to 127.0.0.1.`);
  }
  const entry = await classed('not_built', () => dashboardEntry());
  // Strict: alp web from before the rename that alp cannot prove and so does not stop is in the way.
  reportMigration(await classed('conflict', () => migrateDashboard(home, { strict: true })));
  if (await dashboardDisabled(home)) throw failure('disabled', DISABLED);
  await classed('daemon', () => start());
  const served = await serveDashboard(home, entry, { port });
  if (values.host === 'localhost') served.base = served.base.replace('://127.0.0.1:', '://localhost:');
  const url = addressOf(served);
  if (values.json) {
    console.log(JSON.stringify({ schema: PRINT_SCHEMA, version: PRINT_VERSION, ok: true, url, origin: new URL(served.base).origin, token: served.token, port: served.port, pid: served.pid }));
    return;
  }
  console.log(url);
  if (values.print || values['no-open']) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => console.error('Open the address above in your browser')).unref();
}
