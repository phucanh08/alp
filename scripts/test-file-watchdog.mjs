// Hard per-file wall-clock limit, including leaked handles after tests finish.
// Normal files run without process instrumentation. This is not containment:
// detached descendants may survive a timeout, so shared scratch is retained.
// Before it stops a file that hit the limit, it dumps what it has (t-5294.2): the subtests that ran,
// failed (with their errors) or are still in flight, the file's processes, and (not on Windows) each
// one's open libuv handles from a Node diagnostic report. A passing or failing file costs one extra
// reporter writing a line per subtest to scratch, and a report signal handler nothing triggers.
// The dump adds at most about 6.5 s to the deadline (a 4 s process listing, 2.2 s of reports), and
// never blocks the other files' workers.
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { files, extra, fileTimeoutMs } = JSON.parse(process.argv[2]);
const windows = process.platform === 'win32';
// The reporter node:test would pick by itself for a piped stdout: tap before Node 23, spec since.
const visible = Number(process.versions.node.split('.')[0]) >= 23 ? 'spec' : 'tap';
const progressReporter = pathToFileURL(path.join(import.meta.dirname, 'test-progress-reporter.mjs')).href;
let next = 0;
let failed = false;
let retainScratch = false;
const active = new Set();
function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
    if (result.error || result.status !== 0) console.error(`[test-file] taskkill failed: ${result.error?.message || `status ${result.status}`}`);
  } else {
    // The still-held root is its own process-group leader. Never enumerate or
    // signal stored descendant PIDs after their spawning handles have gone.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(`[test-file] process-group kill failed: ${error.message}`); }
  }
  child.kill('SIGKILL');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  console.error('[test-file] interrupted; retaining scratch; detached descendants may survive');
  for (const child of active) stop(child);
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const indent = (value, by = '    ') => String(value).split('\n').map(line => by + line).join('\n');

/** Which subtests ran, failed (and why) and are still in flight, from the progress reporter's lines. */
function progressSummary(file) {
  let entries;
  try { entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { return [`  no subtest progress (${error.code ?? error.message})`]; }
  const out = [];
  const running = new Map();
  const key = entry => `${entry.nesting}\0${entry.name}\0${entry.line}`;
  let passed = 0;
  for (const entry of entries) {
    if (entry.type === 'test:dequeue') { running.set(key(entry), entry); continue; }
    running.delete(key(entry));
    if (entry.type === 'test:pass') { passed++; continue; }
    out.push(`  not ok: ${entry.name} (${Math.round(entry.ms ?? 0)} ms${entry.error?.failureType ? `, ${entry.error.failureType}` : ''})`);
    if (entry.error?.message) out.push(indent(entry.error.message));
    if (entry.error?.stack && entry.error.stack !== entry.error.message) out.push(indent(entry.error.stack, '      '));
  }
  // Under process isolation the file itself is an entry too (named by its path): it runs until the process ends.
  const inFlight = [...running.values()].filter(entry => !entry.file || path.resolve(entry.name) !== path.resolve(entry.file));
  out.unshift(`  subtests: ${passed} passed, ${entries.filter(entry => entry.type === 'test:fail').length} failed, ${inFlight.length} in flight`);
  if (inFlight.length) for (const entry of inFlight) out.push(`  in flight: ${entry.name}${entry.line ? ` (line ${entry.line})` : ''}, started ${Date.now() - entry.at} ms ago`);
  else out.push('  in flight: none; every subtest finished and the file\'s process stayed alive (an open handle or a pending hook)');
  return out;
}

/** A command's stdout, or why there is none; asynchronous, and killed after `ms`. */
function capture(command, args, ms) {
  return new Promise(resolve => {
    let stdout = '';
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { resolve({ error: error.message }); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ error: `no answer within ${ms} ms` }); }, ms);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.once('error', error => { clearTimeout(timer); resolve({ error: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? { stdout } : { error: `status ${code}` }); });
  });
}

/** The file's processes: its group and descendants (POSIX), or its process tree (Windows). Listed, never signalled. */
async function processSummary(root) {
  if (windows) {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }';
    const result = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 4000);
    if (result.error) return [`  process list unavailable: ${result.error}`];
    const rows = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { const [pid, ppid, ...command] = line.split('\t'); return { pid: Number(pid), ppid: Number(ppid), command: command.join('\t') }; });
    const tree = new Set([root]);
    for (let grew = true; grew;) { grew = false; for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; } }
    return rows.filter(row => tree.has(row.pid)).map(row => `  pid ${row.pid} ppid ${row.ppid}: ${row.command}`);
  }
  const result = await capture('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,etime=,command='], 3000);
  if (result.error) return [`  process list unavailable: ${result.error}`];
  const rows = result.stdout.split('\n').filter(Boolean).map(line => { const [pid, ppid, pgid, stat, etime, ...command] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat, etime, command: command.join(' ') }; });
  const tree = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const row of rows) if (!tree.has(row.pid) && (tree.has(row.ppid) || row.pgid === root)) { tree.add(row.pid); grew = true; } }
  return rows.filter(row => tree.has(row.pid)).map(row => `  pid ${row.pid} ppid ${row.ppid} pgid ${row.pgid} ${row.stat} ${row.etime}: ${row.command.slice(0, 400)}`);
}

/** One line per libuv handle a diagnostic report lists, without the report's environment. */
function handleLines(report) {
  // The executable and its operands; node:test passes the file's process a long list of flags.
  const command = report.header?.commandLine ?? [];
  const out = [`  pid ${report.header?.processId}: ${[command[0], ...command.slice(1).filter(arg => !arg.startsWith('-'))].join(' ').slice(0, 400)}`];
  const stack = report.javascriptStack?.stack;
  if (Array.isArray(stack) && stack.length) out.push(`    js stack: ${report.javascriptStack.message ?? ''}`, ...stack.slice(0, 8).map(frame => `      ${frame}`));
  // Only referenced, active handles keep a process alive; the rest are counted.
  let others = 0;
  for (const handle of report.libuv ?? []) {
    if (handle.type === 'loop') continue;
    if (!handle.is_referenced || !handle.is_active) { others++; continue; }
    const details = ['localEndpoint', 'remoteEndpoint', 'filename', 'pid', 'signal', 'timeout', 'firesInMsFromNow', 'expired']
      .filter(name => handle[name] !== undefined).map(name => `${name}=${JSON.stringify(handle[name])}`);
    out.push(`    ${handle.type}${details.length ? ` ${details.join(' ')}` : ''}`);
  }
  out.push(`    (${others} unreferenced or inactive handles not listed)`);
  if (report.workers?.length) out.push(`    workers: ${report.workers.length}`);
  return out;
}

/** Asks the file's process group for Node diagnostic reports (only processes started with --report-on-signal answer). */
async function handleSummary(root, directory) {
  if (windows) return ['  open handles: not available on Windows (Node diagnostic reports cannot be requested by signal)'];
  mkdirSync(directory, { recursive: true });
  // SIGUSR2 is the report signal; group members without the flag end on it, and are stopped next anyway.
  try { process.kill(-root, 'SIGUSR2'); } catch (error) { return [`  open handles: could not signal the file's group: ${error.message}`]; }
  const deadline = Date.now() + 2000;
  let names = [];
  while (Date.now() < deadline) {
    await sleep(100);
    names = readdirSync(directory).filter(name => name.endsWith('.json'));
    // The node:test runner and the file's own process each write one.
    if (names.length >= 2) { await sleep(100); names = readdirSync(directory).filter(name => name.endsWith('.json')); break; }
  }
  if (!names.length) return ['  open handles: no diagnostic report arrived within 2 s'];
  const out = [];
  for (const name of names.sort()) {
    try { out.push(...handleLines(JSON.parse(readFileSync(path.join(directory, name), 'utf8')))); }
    catch (error) { out.push(`  ${name}: unreadable (${error.message})`); }
  }
  return out;
}

async function dump(file, child, progress, reports) {
  const out = [`[test-file] HANG DUMP ${file} (pid ${child.pid})`, ' subtests:', ...progressSummary(progress), ' processes:', ...await processSummary(child.pid)];
  out.push(' referenced active handles (what keeps each process alive):', ...await handleSummary(child.pid, reports));
  out.push(`[test-file] END HANG DUMP ${file}`);
  console.error(out.join('\n'));
}

async function worker() {
  while (next < files.length) {
    const index = next;
    const file = files[next++];
    const started = Date.now();
    // Under scratch (runNodeTests sets TMPDIR), which a timeout retains.
    const progress = path.join(tmpdir(), `alp-progress-${process.pid}-${index}.jsonl`);
    const reports = path.join(tmpdir(), `alp-reports-${process.pid}-${index}`);
    console.error(`[test-file] START ${file}`);
    const reporting = [`--test-reporter=${visible}`, '--test-reporter-destination=stdout', `--test-reporter=${progressReporter}`, `--test-reporter-destination=${progress}`];
    const diagnostics = windows ? [] : ['--report-on-signal', `--report-directory=${reports}`];
    const child = spawn(process.execPath, ['--test', '--test-timeout=300000', ...reporting, ...diagnostics, ...extra, file], {
      stdio: ['inherit', 'pipe', 'pipe'], detached: !windows,
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    active.add(child);
    let timedOut = false;
    // A detached process may retain output after the root exits. Pipe through
    // this coordinator so the deadline can close its local read handles too.
    const status = await new Promise(resolve => {
      let settled = false;
      const finish = code => { if (!settled) { settled = true; resolve(code); } };
      const timer = setTimeout(async () => {
        timedOut = true;
        retainScratch = true;
        console.error(`[test-file] TIMEOUT ${file} after ${fileTimeoutMs} ms; retaining scratch; detached descendants may survive`);
        // The dump is bounded (about 6.5 s at most) and must not defeat the deadline if it fails.
        try { await dump(file, child, progress, reports); } catch (error) { console.error(`[test-file] hang dump failed: ${error.message}`); }
        stop(child);
        // A failed kill must not defeat the deadline.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(1);
      }, fileTimeoutMs);
      child.once('error', error => {
        retainScratch = true;
        console.error(`[test-file] ${file}: ${error.message}`);
        clearTimeout(timer); finish(1);
      });
      child.once('close', (code, signal) => {
        if (timedOut) return;
        if (signal) retainScratch = true;
        clearTimeout(timer); finish(code ?? 1);
      });
    });
    active.delete(child);
    if (!timedOut) rmSync(progress, { force: true });
    const ok = status === 0 && !timedOut;
    if (!ok) failed = true;
    console.error(`[test-file] ${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - started} ms)`);
  }
}
await Promise.all(Array.from({ length: Math.min(files.length, Math.max(1, availableParallelism() - 1)) }, worker));
if (!retainScratch && process.env.ALP_TEST_RETAIN) unlinkSync(process.env.ALP_TEST_RETAIN);
process.exitCode = failed ? 1 : 0;
