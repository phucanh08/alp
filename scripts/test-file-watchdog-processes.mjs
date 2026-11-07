// The hang dump's process listing (scripts/test-file-watchdog.mjs), in its own module.
//
// Why a module: test-file-watchdog.mjs is an executable script — it reads its work from
// process.argv[2] and ends in a top-level await — so importing it from a test would run it. The
// Windows listing is opt-in behind ALP_WATCHDOG_WIN_PROCS=1 (a cold WMI query took over 4 s on the
// windows-daemon lane and broke the deadline's own bound), which meant nothing ever executed its
// WMI parsing or its process-tree walk. Here `platform`, `env` and `capture` are injected, so a test
// drives both platforms and both sides of the opt-in on any host (t-5294.7, ci.yml lanes `core`,
// `core-paseo-macos` and `windows-daemon`, which all run test/integration/test-env.test.js).
//
// Processes are listed, never signalled: this is diagnosis, not containment.
import { spawn } from 'node:child_process';

/**
 * How long each listing may take. POSIX `ps` answers in milliseconds. The Windows query starts
 * PowerShell and a WMI provider: on a loaded windows-daemon runner it answered in about 0.6-2.2 s
 * and, cold, missed 2.5 s twice (runs 42229826556, 42254412288) and 4 s once (cd0f0c8). It runs only
 * for someone who opted in to chase a hang, after that file's 300 s deadline, while every other
 * file's worker goes on, so a wider bound costs that one dump a few seconds and buys it its process
 * list. Still a hard bound: `capture` kills the query and drops its pipe and handle when it expires.
 */
export const LIST_MS = { posix: 3000, win32: 8000 };

/** A command's stdout, or why there is none; asynchronous, and killed after `ms`. */
export function capture(command, args, ms) {
  return new Promise(resolve => {
    let stdout = '';
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { resolve({ error: error.message }); return; }
    // A listing that outlives its kill must not keep the coordinator alive: drop its pipe and handle too.
    const timer = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.unref(); resolve({ error: `no answer within ${ms} ms` }); }, ms);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.once('error', error => { clearTimeout(timer); resolve({ error: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? { stdout } : { error: `status ${code}` }); });
  });
}

/** The rows of a listing that descend from `root`, by parent, plus `root` itself; input order kept. */
function tree(rows, root, extra = () => false) {
  const members = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!members.has(row.pid) && (members.has(row.ppid) || extra(row))) { members.add(row.pid); grew = true; }
  }
  return rows.filter(row => members.has(row.pid));
}

/**
 * The file's processes: its group and descendants (POSIX), or its process tree (Windows).
 * Listed, never signalled.
 * @param {number} root the pid of the process node:test runs the file in
 */
export async function processSummary(root, { platform = process.platform, env = process.env, capture: run = capture } = {}) {
  if (platform === 'win32') {
    if (env.ALP_WATCHDOG_WIN_PROCS !== '1') return [`  not collected on Windows (ALP_WATCHDOG_WIN_PROCS=1 lists them through WMI, up to ${LIST_MS.win32 / 1000} s more)`];
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }';
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], LIST_MS.win32);
    if (result.error) return [`  process list unavailable: ${result.error}`];
    const rows = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { const [pid, ppid, ...command] = line.split('\t'); return { pid: Number(pid), ppid: Number(ppid), command: command.join('\t') }; });
    return tree(rows, root).map(row => `  pid ${row.pid} ppid ${row.ppid}: ${row.command}`);
  }
  const result = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,etime=,command='], LIST_MS.posix);
  if (result.error) return [`  process list unavailable: ${result.error}`];
  const rows = result.stdout.split('\n').filter(Boolean).map(line => { const [pid, ppid, pgid, stat, etime, ...command] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat, etime, command: command.join(' ') }; });
  // The file's process is its own group leader (spawned detached), so its group is its family too.
  return tree(rows, root, row => row.pgid === root).map(row => `  pid ${row.pid} ppid ${row.ppid} pgid ${row.pgid} ${row.stat} ${row.etime}: ${row.command.slice(0, 400)}`);
}
