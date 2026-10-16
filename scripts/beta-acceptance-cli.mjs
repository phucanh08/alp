#!/usr/bin/env node
// CLI and alpd acceptance on the saved tarballs: docs/alp/beta-scope.md §6.3 C1–C9 (rows R1–R4).
// See beta-acceptance-lib.mjs for the modes. --live calls the real provider and costs money.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CHOICES, Run, VERSION, alpCommand, confirm, environment, follow, gateRow, install, options, sha256, sleep,
} from './beta-acceptance-lib.mjs';

const USAGE = `Usage: node scripts/beta-acceptance-cli.mjs --packs <dir> (--fake | --live --provider codex|claude) [options]

  --packs DIR       the saved release: 8 tarballs, SHA256SUMS, release-manifest.json (§7.2); never repacked
  --fake            hermetic rehearsal with the repository's fake Codex or fake Claude; no model calls; not gate evidence
  --live            the real provider (opt-in, costs money); macOS fills R1/R2, Linux R3/R4
  --provider P      codex or claude (fake: default codex, runs that provider's fake)
  --model M         model for alp setup (--codex-model / --claude-model); default: setup's own
  --work DIR        where the consumer, ALP_HOME, project, logs and results go (default: $TMPDIR/alp-beta)
  --rehearsal       accept a rehearsal pack (dirty checkout, no tag); its results are never gate evidence
  --runner NAME     who ran it, for the gate row (default: the OS user)
  --unattended      live, no person (CI): C5, C6 and C8 are judged by the rules they record; a step
                    the rules cannot confirm stays "check" and the row pending (exit 3)
  --evidence URL    the row's evidence, e.g. the CI run (default: the results file)

Every run gets a fresh ALP_HOME under --work; ~/.alp is never read or written.`;

const opts = options(USAGE, { provider: { type: 'string' }, model: { type: 'string' } });
const provider = opts.provider ?? (opts.fake ? 'codex' : undefined);
if (!['codex', 'claude'].includes(provider)) { console.error(`--provider must be codex or claude (required with --live)\n\n${USAGE}`); process.exit(2); }
if (opts.live && !['darwin', 'linux'].includes(process.platform)) { console.error('Live acceptance runs on macOS or Linux (beta-scope §6.1); use --fake elsewhere.'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `cli-${provider}-${opts.live ? 'live' : 'fake'}-${stamp}`;
const run = new Run({ work: opts.work, name, row: gateRow('cli', provider), mode: opts.live ? 'live' : 'fake', runner: opts.runner, evidence: opts.evidence });
const base = path.join(opts.work, name);
const home = path.join(base, 'home');
const restoredHome = path.join(base, 'home-restored');
const project = path.join(base, 'project');
let consumer;
try { ({ consumer } = install(run, opts)); } catch (error) { run.record('install', 'fail', error.message); process.exit(run.summary()); }
const alp = alpCommand(consumer);
const env = environment({ bin: path.join(consumer, 'node_modules', '.bin'), home, fake: opts.fake });
const restoredEnv = { ...env, ALP_HOME: restoredHome };
const cli = (label, args, extra = {}) => run.exec(label, process.execPath, [alp, ...args], { env, cwd: project, ...extra });
const git = (...args) => run.exec('git', 'git', ['-c', 'user.name=ALP beta', '-c', 'user.email=alp-beta@localhost', ...args], { cwd: project });
const json = (result, what) => { try { return JSON.parse(result.stdout); } catch { throw new Error(`${what} did not print JSON (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`); } };
const settingsFile = path.join(project, '.alp', 'settings.json');
const live = !opts.fake;
/** `alp run --json` in the project, followed until it exits. */
const start = (label, prompt, extra = []) => follow(run, label, ['run', '--json', '--team', 'pho', ...extra, prompt], { env, cwd: project, alp });
const ended = (stream, state) => stream.next(envelope => envelope.sessionId === stream.rootId && envelope.event?.type === 'turn.ended' && state(envelope.event.state), 'the end of the root turn');
let c4Root;
let c4Named = [];
let marker;

mkdirSync(project, { recursive: true });
git('init', '-q', '-b', 'main');
git('commit', '-q', '--allow-empty', '-m', 'init');

try {
  await run.step('C1', 'alp doctor', async () => {
    const result = cli('C1', ['doctor', '--json']);
    const { checks } = json(result, 'alp doctor --json');
    const runtime = checks.find(check => check.id === provider);
    // The fakes stand in for the provider: their own check says nothing about the install.
    const failed = checks.filter(check => check.status === 'fail' && (live || !['codex', 'claude'].includes(check.id)));
    if (live && runtime?.status !== 'ok') throw new Error(`${provider}: ${runtime?.status ?? 'not checked'} — ${runtime?.summary ?? ''}`);
    if (failed.length) throw new Error(`blocking: ${failed.map(check => `${check.id} (${check.summary})`).join('; ')}`);
    run.record('C1', 'pass', live ? `${provider} ok: ${runtime.summary}; no failing check` : `no failing check outside the provider checks (fake ${provider})`, { checks: checks.map(({ id, status, summary }) => ({ id, status, summary })) });
  });

  await run.step('C2', 'alp daemon start && alp daemon status --json', async () => {
    if (cli('C2', ['daemon', 'start']).status !== 0) throw new Error('alp daemon start failed');
    const status = json(cli('C2', ['daemon', 'status', '--json']), 'alp daemon status --json');
    if (!status.running || !status.health?.ready) throw new Error(`alpd not ready: ${JSON.stringify(status.health ?? status)}`);
    if (status.version !== VERSION) throw new Error(`alpd reports version ${status.version}, expected ${VERSION}`);
    run.record('C2', 'pass', `alpd ${status.version} ready (pid ${status.pid})`);
  });

  await run.step('C3', 'alp init && alp setup --runtime P', async () => {
    if (cli('C3', ['init']).status !== 0) throw new Error('alp init failed');
    const model = opts.model ? [`--${provider}-model`, opts.model] : [];
    if (cli('C3', ['setup', '--runtime', provider, ...model]).status !== 0) throw new Error('alp setup failed');
    const teams = json(cli('C3', ['teams', '--json']), 'alp teams --json').map(team => String(team.id ?? team.name).toLowerCase());
    if (!teams.includes('pho') || !teams.includes('cafe')) throw new Error(`teams are ${teams.join(', ')}; expected pho and cafe`);
    // A task to find again after the restore of C9; the worktrees of C7 need a committed checkout.
    const added = cli('C3', ['task', 'add', 'C9 restore marker']);
    if (added.status !== 0) throw new Error('alp task add failed');
    marker = json(cli('C3', ['tasks', '--all', '--json']), 'alp tasks --all --json').find(task => task.title === 'C9 restore marker')?.id;
    // The fakes hold any turn whose prompt says [hold], and main's prompt reaches the supervisor's
    // review: with a supervisor C5 would never go idle. A live run keeps Phở's supervisor.
    if (opts.fake) writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), workflow: { ...JSON.parse(readFileSync(settingsFile, 'utf8')).workflow, supervisor: false } }, null, 2));
    git('add', '-A');
    git('commit', '-q', '-m', 'alp init');
    run.record('C3', 'pass', `settings.json written; teams ${teams.join(', ')}; task ${marker} added for C9${opts.fake ? '; supervisor off (fake only)' : ''}`);
  });

  await run.step('C4', 'alp run --team pho (read-only question), then alp ps --all', async () => {
    const stream = start('C4', 'Đọc thư mục này và trả lời nó có những file nào. Không sửa gì.');
    const code = await stream.exit;
    c4Root = stream.rootId;
    if (code !== 0) throw new Error(`alp run exited ${code}: ${stream.stderr().trim().slice(-300)}`);
    const answer = stream.answers().at(-1);
    if (!answer) throw new Error('no answer streamed');
    const ps = cli('C4', ['ps', '--all']).stdout;
    if (!ps.includes(c4Root.slice(0, 12))) throw new Error(`alp ps --all does not list ${c4Root}`);
    // What C8 should remember: the project's entries this answer names.
    c4Named = readdirSync(project).filter(entry => entry !== '.git' && answer.toLowerCase().includes(entry.toLowerCase()));
    run.record('C4', 'pass', `session ${c4Root} answered and is listed`, { session: c4Root, answer: answer.slice(0, 2000) });
  });

  await run.step('C5', 'alp interrupt, then Ctrl-C, then alp send', async () => {
    // A fake holds a turn open on [hold]; a real model counts slowly.
    const prompt = `Đếm chậm từ 1 tới 200, mỗi số một dòng.${opts.fake ? ' [hold]' : ''}`;
    const first = start('C5-interrupt', prompt);
    await first.next(envelope => envelope.sessionId === first.rootId && envelope.event?.type === 'turn.started', 'the root turn');
    if (live) await sleep(5000);
    if (cli('C5', ['interrupt', first.rootId]).status !== 0) throw new Error('alp interrupt failed');
    const stopped = await ended(first, state => state !== 'completed');
    const code = await first.exit;
    if (!/interrupt|cancel/.test(stopped.event.state)) throw new Error(`the turn ended ${stopped.event.state}`);
    const states = [`alp interrupt: ${stopped.event.state}, exit ${code}`];
    if (process.platform !== 'win32') {
      const second = start('C5-ctrl-c', prompt);
      await second.next(envelope => envelope.sessionId === second.rootId && envelope.event?.type === 'turn.started', 'the root turn');
      if (live) await sleep(5000);
      second.child.kill('SIGINT');
      const ctrlC = await ended(second, state => state !== 'completed');
      await second.exit;
      if (!/interrupt|cancel/.test(ctrlC.event.state)) throw new Error(`Ctrl-C: the turn ended ${ctrlC.event.state}`);
      states.push(`Ctrl-C: ${ctrlC.event.state}`);
    } else states.push('Ctrl-C not tried on Windows (no SIGINT to a child)');
    const ps = cli('C5', ['ps']).stdout;
    const again = follow(run, 'C5-send', ['send', '--json', first.rootId, 'Bạn đã dừng ở số mấy?'], { env, cwd: project, alp });
    const sent = await again.exit;
    if (sent !== 0) throw new Error(`alp send after the interrupt exited ${sent}`);
    run.record('C5', live ? 'check' : 'pass', `${states.join('; ')}; alp send ran${live ? ' — read its answer' : ''}`, { session: first.rootId, ps, answer: again.answers().at(-1)?.slice(0, 2000) });
    const answer = again.answers().at(-1) ?? '';
    const busy = ps.split('\n').filter(line => /\srunning\s/.test(line));
    if (live) await confirmStep('C5', 'The answer says where the count stopped, and alp ps showed no running turn.', {
      ok: /\d/.test(answer) && !busy.length,
      rule: `the answer names a number (${/\d/.test(answer) ? 'yes' : 'no'}) and no alp ps line is running (${busy.length ? busy.join(' | ') : 'none'})`,
    });
  });

  await run.step('C6', 'permission questions through alp questions / alp answer', async () => {
    if (opts.fake) {
      run.record('C6', 'skip', `the fake ${provider} asks no permission; covered hermetically by integrations/paseo/tests/permissions.test.js and test/integration/permissions.test.js`);
      return;
    }
    const original = readFileSync(settingsFile, 'utf8');
    // An ask rule (two choices, asks each time) and beyond the read-only mode (three choices).
    const profile = { profiles: { review: { base: 'read-only', ask: ['Bash(touch *)'], beyondMode: 'ask' } }, agents: { main: 'review' } };
    writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), permissions: profile }, null, 2));
    try {
      const say = command => `Tự chạy đúng một lệnh shell này, không giao cho ai và không dùng cách khác: \`${command}\`. Nếu bị từ chối thì báo lại là bị từ chối, đừng thử cách khác.`;
      const once = await permission('C6-once', say('touch c6-once.txt'), 'once', 2);
      if (!existsSync(path.join(project, 'c6-once.txt'))) throw new Error('Allow once was answered but c6-once.txt does not exist');
      const deny = await permission('C6-deny', say('touch c6-deny.txt'), 'deny', 2);
      if (existsSync(path.join(project, 'c6-deny.txt'))) throw new Error('Deny was answered but c6-deny.txt exists');
      const always = await permission('C6-always', say('mkdir -p c6-always'), 'always', 3);
      const rules = JSON.parse(readFileSync(settingsFile, 'utf8')).permissions?.profiles?.review?.allow ?? [];
      if (!rules.some(rule => rule.startsWith('Bash(mkdir'))) throw new Error(`Always allow added no mkdir rule to profile review (allow: ${JSON.stringify(rules)})`);
      const after = await permission('C6-again', say('mkdir -p c6-always'), null);
      run.record('C6', 'check', `Allow once ran it, Deny refused it, Always allow added ${rules.join(', ')}, and the same command then ran without a question — read the Deny answer`, { sessions: [once.root, deny.root, always.root, after.root], denyAnswer: deny.answer?.slice(0, 1000) });
      const refused = /từ chối|bị chặn|không được phép|không có quyền|denied|refused|rejected|declined|not (allowed|permitted)/i.test(deny.answer ?? '');
      await confirmStep('C6', 'After Deny the agent said it was refused (see denyAnswer in the results).', {
        ok: refused, rule: `the Deny answer ${refused ? 'says' : 'does not say'} it was refused (từ chối / denied / refused / not allowed …)`,
      });
    } finally {
      // Main must write again for C7; the rule Always allow added is already in the evidence.
      writeFileSync(settingsFile, original);
    }
  });

  await run.step('C7', 'two peers in worktrees, merged with alp_merge', async () => {
    if (opts.fake) { run.record('C7', 'skip', 'needs a real model; hermetic coverage: packages/runtime/tests/worktree.test.js'); return; }
    const stream = start('C7', 'Giao hai peer ghi song song, mỗi peer trong worktree riêng: peer 1 tạo a.txt chứa A, peer 2 tạo b.txt chứa B; rồi merge cả hai bằng alp_merge.');
    const code = await stream.exit;
    if (code !== 0) throw new Error(`alp run exited ${code}`);
    const entries = cli('C7', ['log', stream.rootId, '--json']).stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
    const count = event => entries.filter(entry => entry.event === event).length;
    const files = ['a.txt', 'b.txt'].map(file => [file, existsSync(path.join(project, file)) ? readFileSync(path.join(project, file), 'utf8').trim() : null]);
    const worktrees = git('worktree', 'list', '--porcelain').stdout.split('\n').filter(line => line.startsWith('worktree ')).length;
    const problems = [];
    if (count('worktree.created') < 2) problems.push(`${count('worktree.created')} worktrees created`);
    if (count('worktree.merged') < 2) problems.push(`${count('worktree.merged')} merges`);
    if (files.some(([, text]) => text === null)) problems.push(`missing ${files.filter(([, text]) => text === null).map(([file]) => file).join(', ')}`);
    if (worktrees !== 1) problems.push(`git worktree list has ${worktrees} entries`);
    if (problems.length) throw new Error(problems.join('; '));
    run.record('C7', 'pass', `2 worktrees created and merged; ${files.map(([file, text]) => `${file}=${text}`).join(', ')}; no worktree left`, { session: stream.rootId });
  });

  await run.step('C8', 'alp daemon restart, then alp send to the C4 session', async () => {
    if (!c4Root) throw new Error('C4 has no session');
    if (cli('C8', ['daemon', 'restart']).status !== 0) throw new Error('alp daemon restart failed');
    const stream = follow(run, 'C8', ['send', '--json', c4Root, 'Nhắc lại câu trả lời trước trong một dòng.'], { env, cwd: project, alp });
    const code = await stream.exit;
    if (code !== 0) throw new Error(`alp send exited ${code}`);
    const answer = stream.answers().at(-1);
    run.record('C8', live ? 'check' : 'pass', `the C4 session ran on after the restart${live ? ' — read whether it remembers' : ''}`, { session: c4Root, answer: answer?.slice(0, 2000) });
    const recalled = c4Named.filter(entry => (answer ?? '').toLowerCase().includes(entry.toLowerCase()));
    if (live) await confirmStep('C8', `It repeats the C4 answer (see "answer" of C4 and C8 in the results):\n  ${answer?.slice(0, 400)}`, {
      ok: recalled.length > 0,
      rule: c4Named.length ? `names again what C4 named (${c4Named.join(', ')}): ${recalled.join(', ') || 'none'}` : 'C4 named no entry of the project, so nothing to compare',
    });
  });

  await run.step('C9', 'backup, verify, dry-run restore, restore into a new ALP_HOME', async () => {
    const file = path.join(base, 'c9.alpbackup');
    if (cli('C9', ['backup', '--stop', '-o', file, '--json']).status !== 0) throw new Error('alp backup --stop failed');
    const verified = json(cli('C9', ['backup', 'verify', file, '--json']), 'alp backup verify --json');
    const before = [sha256(settingsFile), readdirSync(home).sort().join(',')];
    const dry = cli('C9', ['restore', file, '--stop', '--dry-run', '--json']);
    if (dry.status !== 0) throw new Error('alp restore --dry-run failed');
    if (JSON.stringify([sha256(settingsFile), readdirSync(home).sort().join(',')]) !== JSON.stringify(before)) throw new Error('the dry run changed the project settings or ALP_HOME');
    // The same backup restored into an empty home: a fresh machine, same project paths.
    mkdirSync(restoredHome, { recursive: true, mode: 0o700 });
    const restore = run.exec('C9', process.execPath, [alp, 'restore', file, '--stop', '--json'], { env: restoredEnv, cwd: project });
    if (restore.status !== 0) throw new Error(`alp restore into ${restoredHome} failed`);
    if (run.exec('C9', process.execPath, [alp, 'daemon', 'start'], { env: restoredEnv, cwd: project }).status !== 0) throw new Error('alpd did not start on the restored home');
    const ps = run.exec('C9', process.execPath, [alp, 'ps', '--all'], { env: restoredEnv, cwd: project }).stdout;
    // --all: main may pick the marker up and close it during C7.
    const tasks = json(run.exec('C9', process.execPath, [alp, 'tasks', '--all', '--json'], { env: restoredEnv, cwd: project }), 'alp tasks --all --json');
    const problems = [];
    if (c4Root && !ps.includes(c4Root.slice(0, 12))) problems.push(`the restored alpd does not list ${c4Root}`);
    if (marker && !tasks.some(task => task.id === marker)) problems.push(`task ${marker} is missing after the restore`);
    if (problems.length) throw new Error(problems.join('; '));
    const stream = follow(run, 'C9-send', ['send', '--json', c4Root, 'Bạn còn đó không? Trả lời một dòng.'], { env: restoredEnv, cwd: project, alp });
    const code = await stream.exit;
    if (code !== 0) throw new Error(`alp send into the restored session exited ${code}`);
    run.record('C9', 'pass', `backup ${verified.sessions} sessions / ${verified.tasks} tasks verified; dry run changed nothing; restored home lists ${c4Root} and task ${marker}; alp send ran`, { backup: file });
  });
} finally {
  // Leave no alpd behind; stop is a no-op where none runs.
  run.exec('cleanup', process.execPath, [alp, 'daemon', 'stop'], { env: restoredEnv, cwd: project });
  run.exec('cleanup', process.execPath, [alp, 'daemon', 'stop'], { env, cwd: project });
}
console.log(`\nAfter each machine: read ${path.join(home, 'logs', 'alpd.log')} for errors nobody explained (beta-scope §6.3).`);
process.exit(run.summary());

/**
 * One permission round: runs `prompt`, waits for the question, checks it in `alp questions --json`,
 * answers with the choice of `key` through `alp answer`, and waits for the run to end. With `key`
 * null it expects no question at all.
 */
async function permission(label, prompt, key, choices) {
  const stream = start(label, prompt);
  const question = stream.next(envelope => envelope.event?.type === 'question', 'a permission question', 5 * 60_000);
  if (key === null) {
    const code = await stream.exit;
    if (stream.envelopes.some(envelope => envelope.event?.type === 'question')) throw new Error(`${label}: asked again, though Always allow covers it`);
    if (code !== 0) throw new Error(`${label}: alp run exited ${code}`);
    question.catch(() => {});
    return { root: stream.rootId, answer: stream.answers().at(-1) };
  }
  const { event } = await question;
  const options = event.question.options ?? [];
  if (options.length !== choices) throw new Error(`${label}: ${options.length} choices (${options.join(' | ')}), expected ${choices}`);
  const pending = JSON.parse(cli(label, ['questions', '--json']).stdout || '[]');
  if (!pending.some(entry => entry.id === event.question.id)) throw new Error(`${label}: alp questions does not list ${event.question.id}`);
  const choice = options.find(option => CHOICES[key].includes(option));
  if (!choice) throw new Error(`${label}: no ${key} choice among ${options.join(' | ')}`);
  if (cli(label, ['answer', event.question.id, choice]).status !== 0) throw new Error(`${label}: alp answer failed`);
  const code = await stream.exit;
  if (code !== 0) throw new Error(`${label}: alp run exited ${code}`);
  return { root: stream.rootId, answer: stream.answers().at(-1), question: event.question };
}

/**
 * Turns a "check" step into pass or fail when a person confirms it on a terminal. Unattended, the
 * rule `judged` decides a pass; a step it cannot confirm stays "check" for a person to read.
 */
async function confirmStep(id, what, judged) {
  if (opts.unattended) {
    if (judged.ok) run.record(id, 'pass', `judged unattended: ${judged.rule}`);
    else run.record(id, 'check', `unattended rule not met, a person must read the results: ${judged.rule}`);
    return;
  }
  const verdict = await confirm(`${id}: ${what}`);
  if (verdict === undefined) return;
  run.record(id, verdict ? 'pass' : 'fail', verdict ? 'confirmed by the person running it' : 'the person running it did not see that');
}
