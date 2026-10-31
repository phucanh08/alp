// Shared harness for the beta acceptance runs of docs/alp/beta-scope.md §6.3 (C1–C9, W1–W6, R7).
// It installs the eight saved tarballs as they are (checked against SHA256SUMS and the release
// manifest by release-lib.mjs; never repacked), runs the steps against that install in a throwaway
// ALP_HOME, and records every step with its evidence in <work>/results-<run>.json, plus the gate
// row fragment (release-lib.mjs `rows` shape) the person running it pastes into the evidence file.
//
// Two modes, never mixed:
//   --fake  hermetic: the repository's fake Codex and fake Claude (no model calls, no cost). Checks
//           the harness and the install; it is never gate evidence and records status "rehearsal".
//           CI runs it on Linux, macOS and Windows (release-acceptance.yml, D7).
//   --live  opt-in: the real provider of --provider, at the user's cost. Only this can pass a row.
//
// A live run asks a person to confirm what a script cannot see for itself. With --unattended (CI,
// .github/workflows/release-acceptance.yml) a step a script can judge is judged by the rule it
// records; one it cannot judge stays "check", so the row stays pending until a person reads it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RELEASE_NAMES, releaseArtifacts } from './release-lib.mjs';
import { spawnCommand } from './spawn-command.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const VERSION = '0.0.1-beta.6';
export const FAKE_CODEX = path.join(ROOT, 'packages/daemon/tests/support/fake-codex.js');
export const FAKE_CLAUDE = path.join(ROOT, 'packages/daemon/tests/support/fake-claude.js');
/** The choices of a permission question, in either language alpd may ask in (ALPD §54). */
export const CHOICES = {
  once: ['Allow once', 'Cho phép lần này'],
  always: ['Always allow', 'Luôn cho phép'],
  deny: ['Deny', 'Từ chối'],
};

/** Parses the shared flags plus `extra`; exits with `usage` on a mistake. */
export function options(usage, extra = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: {
      packs: { type: 'string' }, work: { type: 'string' }, fake: { type: 'boolean' }, live: { type: 'boolean' },
      rehearsal: { type: 'boolean' }, runner: { type: 'string' }, unattended: { type: 'boolean' }, evidence: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, ...extra,
    } }).values;
  } catch (error) { console.error(`${error.message}\n\n${usage}`); process.exit(2); }
  if (parsed.help) { console.log(usage); process.exit(0); }
  if (!!parsed.fake === !!parsed.live) { console.error(`Choose exactly one of --fake (hermetic) or --live (real provider, costs money).\n\n${usage}`); process.exit(2); }
  if (parsed.unattended && !parsed.live) { console.error(`--unattended judges live steps; a --fake run has none to judge.\n\n${usage}`); process.exit(2); }
  parsed.work = path.resolve(parsed.work ?? path.join(os.tmpdir(), 'alp-beta'));
  return parsed;
}

/** One acceptance run: its steps, logs and the row fragment for the gate evidence. */
export class Run {
  constructor({ work, name, row, mode, manifest, runner, evidence }) {
    this.work = work;
    this.logs = path.join(work, 'logs', name);
    mkdirSync(this.logs, { recursive: true });
    this.file = path.join(work, `results-${name}.json`);
    this.row = row;
    this.mode = mode;
    this.manifest = manifest;
    this.steps = [];
    this.environment = `${os.type()} ${os.release()} ${os.arch()}, node ${process.version}, npm ${capture('npm', ['-v']).trim() || '?'}`;
    this.runner = runner ?? os.userInfo().username;
    // Where the row's evidence lives for whoever reads the gate: a CI run's URL, else this file.
    this.evidence = evidence;
    this.save();
  }

  /** Records a step: pass, fail, check (a person must look), skip or pending. */
  record(id, status, detail, evidence = {}) {
    const mark = { pass: 'PASS', fail: 'FAIL', check: 'CHECK', skip: 'SKIP', pending: 'TODO' }[status] ?? status;
    console.log(`[${mark}] ${id}: ${detail}`);
    this.steps.push({ id, status, detail, ...evidence, at: new Date().toISOString() });
    this.save();
  }

  /** Runs `body` as step `id`; an exception fails the step without stopping the run. */
  async step(id, title, body) {
    console.log(`\n== ${id}: ${title}`);
    try { await body(); } catch (error) { this.record(id, 'fail', error.message.split('\n')[0], { error: String(error.stack ?? error).slice(0, 4000) }); }
  }

  /** A command's result, logged in full under logs/; the step reads stdout/stderr. */
  exec(label, command, args, { env, cwd, input, timeout = 30 * 60_000 } = {}) {
    const [file, argv] = spawnCommand(command, args);
    const result = spawnSync(file, argv, { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    this.log(label, `$ ${command} ${args.map(quote).join(' ')}\n[exit ${result.status ?? result.signal ?? result.error?.message}]\n--- stdout\n${result.stdout ?? ''}\n--- stderr\n${result.stderr ?? ''}`);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  }

  log(label, text) { appendFileSync(path.join(this.logs, `${label}.log`), `${text}\n`); }

  /** Each step's latest record: a person's confirmation replaces the "check" before it. */
  latest() { return [...new Map(this.steps.map(step => [step.id, step])).values()]; }

  /** The row status a gate may count: pass only when live and every step passed or a person confirmed it. */
  verdict() {
    if (this.mode !== 'live') return 'rehearsal';
    const steps = this.latest();
    if (steps.some(step => step.status === 'fail')) return 'fail';
    if (steps.some(step => step.status !== 'pass')) return 'pending';
    return 'pass';
  }

  save() {
    const fragment = {
      [this.row]: {
        // R7 runs the source at the release SHA, not the tarballs: it binds the SHA only.
        status: this.verdict(), sha: this.sha ?? this.manifest?.git?.sha ?? null, artifacts: this.row === 'R7' ? null : this.manifest?.sha256sums ?? null,
        environment: this.environment, runner: this.runner, evidence: this.evidence ?? this.file, date: new Date().toISOString().slice(0, 10),
      },
    };
    writeFileSync(this.file, `${JSON.stringify({ schema: 1, mode: this.mode, version: VERSION, rows: fragment, steps: this.steps }, null, 2)}\n`);
  }

  summary() {
    const count = status => this.latest().filter(step => step.status === status).length;
    console.log(`\n${this.row} (${this.mode}): ${count('pass')} pass, ${count('fail')} fail, ${count('check')} to check, ${count('skip')} skipped, ${count('pending')} pending → row status "${this.verdict()}"`);
    console.log(`results: ${this.file}\nlogs:    ${this.logs}`);
    if (this.mode !== 'live') console.log('A --fake run checks the harness and the install only; it is not gate evidence.');
    // 1: a step failed (a rehearsal too); 3: live, but some step still needs a person; 0 otherwise.
    if (this.latest().some(step => step.status === 'fail')) return 1;
    return this.verdict() === 'pending' ? 3 : 0;
  }
}

/**
 * The saved release in `packs`: checked (release-lib.mjs) and installed exactly as packed into
 * <work>/consumer. Returns the manifest, the consumer directory and its bin directory.
 */
export function install(run, { packs, rehearsal }) {
  if (!packs) throw new Error(`--packs <directory with the ${RELEASE_NAMES.length} tarballs, SHA256SUMS and release-manifest.json> is required`);
  const directory = path.resolve(packs);
  const artifacts = releaseArtifacts(directory, { rehearsal });
  if (artifacts.length !== RELEASE_NAMES.length && !rehearsal) throw new Error(`expected ${RELEASE_NAMES.length} release tarballs, found ${artifacts.length}`);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== VERSION) throw new Error(`release is ${manifest.version}, expected ${VERSION}`);
  run.manifest = manifest;
  const consumer = path.join(run.work, 'consumer');
  if (!existsSync(path.join(consumer, 'package.json'))) {
    mkdirSync(consumer, { recursive: true });
    writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({ name: 'alp-beta-consumer', private: true }, null, 2)}\n`);
  }
  const installed = run.exec('install', 'npm', ['install', '--save-exact', '--no-audit', '--no-fund', ...artifacts.map(artifact => artifact.file)], { cwd: consumer });
  if (installed.status !== 0) throw new Error(`npm install of the tarballs failed; see ${run.logs}/install.log`);
  const listed = run.exec('install', 'npm', ['ls', '--all', '--json'], { cwd: consumer });
  const versions = new Map();
  (function walk(node) {
    for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
      if (name.startsWith('@anhlp/')) versions.set(`${name}@${child.version}`, true);
      walk(child);
    }
  })(JSON.parse(listed.stdout || '{}'));
  const stray = [...versions.keys()].filter(entry => !entry.endsWith(`@${VERSION}`));
  if (stray.length) throw new Error(`the install resolves @anhlp packages at other versions: ${stray.join(', ')}`);
  run.record('install', 'pass', `${artifacts.length} tarballs (SHA256SUMS ${manifest.sha256sums?.slice(0, 12)}…, release SHA ${manifest.git?.sha?.slice(0, 12) ?? '?'}) installed in ${consumer}; every @anhlp/* is ${VERSION}`, { sha256sums: manifest.sha256sums, releaseSha: manifest.git?.sha });
  return { manifest, consumer, bin: path.join(consumer, 'node_modules', '.bin') };
}

/** The environment the steps run in: the consumer's bins first, a throwaway ALP_HOME, both fakes if asked. */
export function environment({ bin, home, fake }) {
  // alpd refuses an ALP_HOME others can read (0700, POSIX); an existing home keeps its mode.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ALP_HOME: home };
  // Both fakes, whichever runtime the project uses: a fake run can never reach a real provider.
  if (fake) Object.assign(env, { ALP_CODEX_BIN: FAKE_CODEX, ALP_CLAUDE_BIN: FAKE_CLAUDE });
  return env;
}

/**
 * The ALP CLI the consumer installed, run by this Node so Windows needs no shell shim: @anhlp/alp-cli's
 * JavaScript (@anhlp/alp is a thin wrapper around it since t-1807).
 */
export function alpCommand(consumer) {
  return path.join(consumer, 'node_modules', '@anhlp', 'alp-cli', 'dist', 'cli.js');
}

/**
 * `alp run --json` (or `alp send --json`) in the background: its envelopes as they arrive, a way
 * to wait for one, and its exit. The root session id is the first session.opened without a parent.
 */
export function follow(run, label, args, { env, cwd, alp }) {
  const child = spawn(process.execPath, [alp, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const envelopes = [];
  const waiting = [];
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      run.log(label, line);
      let envelope;
      try { envelope = JSON.parse(line); } catch { continue; }
      envelopes.push(envelope);
      for (const wait of [...waiting]) if (wait.test(envelope)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(envelope); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; run.log(label, `[stderr] ${String(chunk).trimEnd()}`); });
  let finished = false;
  const closed = new Promise(resolve => child.on('close', code => {
    finished = true;
    for (const wait of [...waiting]) wait.reject(new Error(`alp ${args[0]} exited before ${wait.what}`));
    resolve(code);
  }));
  child.on('error', error => {
    for (const wait of [...waiting]) wait.reject(error);
  });
  // No step waits forever: a run still going after `ms` is stopped and its step fails.
  const ms = Number(process.env.ALP_ACCEPT_TIMEOUT_MS) || 20 * 60_000;
  let timer;
  const exit = Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`alp ${args[0]} still running after ${Math.round(ms / 1000)} s; stopped (log: ${label}.log)`)); }, ms); })]).finally(() => clearTimeout(timer));
  exit.catch(() => {});
  return {
    child, envelopes, exit, stderr: () => stderr,
    async stop({ graceMs = 1000, forceMs = 1000 } = {}) {
      const closesWithin = async ms => {
        let deadline;
        try { return await Promise.race([closed.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), ms); })]); }
        finally { clearTimeout(deadline); }
      };
      if (finished) return;
      child.kill();
      if (await closesWithin(graceMs)) return;
      child.kill('SIGKILL');
      if (await closesWithin(forceMs)) return;
      // A descendant may retain the pipes even after this viewer dies. Do not let
      // its inherited handles or the overall follow timer keep acceptance alive.
      child.stdout.destroy();
      child.stderr.destroy();
      clearTimeout(timer);
      for (const wait of [...waiting]) wait.reject(new Error('alp viewer did not close after forced termination'));
      throw new Error('alp viewer did not close after forced termination');
    },
    get rootId() { return envelopes.find(envelope => envelope.event?.type === 'session.opened' && !envelope.event.session?.parentId)?.sessionId; },
    /** Waits for an envelope matching `test`, or fails after `ms`. */
    next(test, what, ms = 10 * 60_000) {
      const found = envelopes.find(test);
      if (found) return Promise.resolve(found);
      if (finished) return Promise.reject(new Error(`alp ${args[0]} exited before ${what}`));
      return new Promise((resolve, reject) => {
        const settle = (done, value) => {
          clearTimeout(timer);
          const index = waiting.indexOf(wait);
          if (index >= 0) waiting.splice(index, 1);
          done(value);
        };
        const wait = { test, what, resolve: value => settle(resolve, value), reject: error => settle(reject, error) };
        const timer = setTimeout(() => wait.reject(new Error(`no ${what} within ${Math.round(ms / 1000)} s`)), ms);
        waiting.push(wait);
      });
    },
    /** The final assistant text of each root turn, for a person to read. */
    answers() { return envelopes.filter(envelope => envelope.sessionId === this.rootId && envelope.event?.type === 'item' && envelope.event.item?.kind === 'assistant_message').map(envelope => envelope.event.item.text); },
  };
}

/** Exercise C5 against the initial root turn. */
export async function interruptTurn(stream, interrupt, { timeout = 10 * 60_000, waitForOutput = false } = {}) {
  try {
    const started = await stream.next(e => e.sessionId === stream.rootId && e.event?.type === 'turn.started' && e.event.origin === 'user', 'the root user turn', timeout);
    const terminal = e => e.sessionId === started.sessionId && e.event?.type === 'turn.ended' && e.event.turnId === started.event.turnId;
    // Live: wait for model output or termination, not a fixed delay. The fake Codex [hold]
    // deliberately emits no output, so its rehearsal interrupts at turn.started.
    if (waitForOutput) await stream.next(e => terminal(e) || (e.sessionId === started.sessionId && e.event?.type === 'item' && ['assistant_message', 'tool_call'].includes(e.event.item?.kind)), 'root output or termination', timeout);
    const before = stream.envelopes.find(terminal);
    if (before) {
      if (before.event.state === 'completed') return { status: 'pending', state: 'completed', turnId: started.event.turnId };
      throw new Error(`root turn ended ${before.event.state} before interrupt`);
    }
    await interrupt();
    const stopped = await stream.next(terminal, 'the interrupted root turn', timeout);
    // After dispatch, completion is a failure: do not retry away a possibly ignored interrupt.
    if (stopped.event.state !== 'canceled') throw new Error(`after interrupt the root turn ended ${stopped.event.state}`);
    return { status: 'canceled', state: 'canceled', turnId: started.event.turnId, code: await stream.exit };
  } finally { await stream.stop(); }
}

/** Asks a person a yes/no question on a terminal; without one the step stays pending. */
export async function confirm(question) {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} [y/n/s(kip)] `)).trim().toLowerCase();
      if (['y', 'yes', 'c', 'có'].includes(answer)) return true;
      if (['n', 'no', 'k', 'không'].includes(answer)) return false;
      if (['s', 'skip'].includes(answer)) return undefined;
    }
  } finally { rl.close(); }
}

/** A manual step: instructions, then the person's verdict. */
export async function manual(run, id, instructions, expected) {
  console.log(`\n== ${id} (manual)\n${instructions}\nExpected: ${expected}`);
  const verdict = await confirm(`${id}: did you see exactly that?`);
  if (verdict === undefined) run.record(id, 'pending', 'not confirmed by a person (no terminal, or skipped)', { instructions, expected });
  else if (verdict) run.record(id, 'pass', 'confirmed by the person running it', { instructions, expected });
  else {
    const note = process.stdin.isTTY ? await ask('What did you see instead? ') : '';
    run.record(id, 'fail', note || 'the person running it saw something else', { instructions, expected });
  }
}

export async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** stdout of a command, or '' when it fails or is missing. */
export function capture(command, args, options = {}) {
  try {
    const [file, argv] = spawnCommand(command, args);
    const result = spawnSync(file, argv, { encoding: 'utf8', ...options });
    return result.status === 0 ? result.stdout : '';
  } catch { return ''; }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const sha256 = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;

/** The gate row a run on this OS fills: macOS R1/R2/R5, Linux R3/R4/R6; elsewhere none counts. */
export function gateRow(kind, provider) {
  const rows = { darwin: { codex: 'R1', claude: 'R2', web: 'R5' }, linux: { codex: 'R3', claude: 'R4', web: 'R6' } };
  return rows[process.platform]?.[kind === 'web' ? 'web' : provider] ?? `${kind}-${process.platform}`;
}

const quote = arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
