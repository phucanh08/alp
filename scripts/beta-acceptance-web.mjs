#!/usr/bin/env node
// Plugin and `alp web` acceptance on the saved tarballs: docs/alp/beta-scope.md §6.3 W1–W6 (rows R5, R6).
// --live adds the plugin to the Paseo on this machine and needs a person for W3–W5; --fake checks
// only what needs no Paseo and no model: W6's token gate on a throwaway ALP_HOME.
import { cleanupFakeWeb, freeWebPort } from './beta-web-lifecycle.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { CHOICES, Run, alpCommand, environment, gateRow, install, manual, options } from './beta-acceptance-lib.mjs';

const USAGE = `Usage: node scripts/beta-acceptance-web.mjs --packs <dir> (--fake | --live --provider codex|claude) [options]

  --packs DIR          the saved release (§7.2); never repacked
  --fake               W6's token gate only, on a throwaway ALP_HOME with the fakes; not gate evidence
  --live               W1–W6 with the Paseo 0.11.x on this machine (R5 on macOS, R6 on Linux); W3–W5 need you
  --provider P         codex or claude: the runtime alp setup gives the project's teams
  --use-default-home   allow ALP_HOME to be ~/.alp (Paseo's default). Back it up first (alp daemon stop, copy it),
                       or run as another OS user, or start Paseo with the ALP_HOME you export here (§6.3)
  --work DIR, --rehearsal, --runner NAME   as for beta-acceptance-cli.mjs`;

const opts = options(USAGE, { provider: { type: 'string' }, 'use-default-home': { type: 'boolean' } });
if (opts.unattended) { console.error('--unattended is not available for W1–W6 yet: W3–W5 and the browser half of W6 need a person.'); process.exit(2); }
const provider = opts.provider ?? (opts.fake ? 'codex' : undefined);
if (!['codex', 'claude'].includes(provider)) { console.error(`--provider must be codex or claude (required with --live)\n\n${USAGE}`); process.exit(2); }
if (opts.live && !['darwin', 'linux'].includes(process.platform)) { console.error('Live acceptance runs on macOS or Linux (beta-scope §6.1).'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `web-${provider}-${opts.live ? 'live' : 'fake'}-${stamp}`;
const run = new Run({ work: opts.work, name, row: gateRow('web'), mode: opts.live ? 'live' : 'fake', runner: opts.runner, evidence: opts.evidence });
const base = path.join(opts.work, name);
const project = path.join(base, 'project');
// Paseo starts alpd with its own environment: live runs use the ALP_HOME Paseo uses, never a silent default.
const defaultHome = path.join(os.homedir(), '.alp');
const home = opts.fake ? path.join(base, 'home') : path.resolve(process.env.ALP_HOME ?? defaultHome);
if (opts.live && home === defaultHome && !opts['use-default-home']) {
  console.error(`ALP_HOME is ${defaultHome}, your own. Export ALP_HOME to the home Paseo uses for this run, or pass --use-default-home after backing it up.`);
  process.exit(2);
}
let consumer;
try { ({ consumer } = install(run, opts)); } catch (error) { run.record('install', 'fail', error.message); process.exit(run.summary()); }
const plugin = path.join(consumer, 'node_modules', '@anhlp', 'alp-paseo');
const alp = alpCommand(consumer);
const env = environment({ bin: path.join(consumer, 'node_modules', '.bin'), home, fake: opts.fake });
const cli = (label, args) => run.exec(label, process.execPath, [alp, ...args], { env, cwd: project });
const paseo = (label, args) => run.exec(label, 'paseo', args, { env, cwd: project });
const settingsFile = path.join(project, '.alp', 'settings.json');

try {
  if (opts.fake) writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ web: { port: await freeWebPort(), relay: { enabled: false } } }));
  mkdirSync(project, { recursive: true });
  run.exec('git', 'git', ['init', '-q', '-b', 'main'], { cwd: project });
  run.exec('git', 'git', ['-c', 'user.name=ALP beta', '-c', 'user.email=alp-beta@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: project });
  if (cli('setup', ['init']).status !== 0 || cli('setup', ['setup', '--runtime', provider]).status !== 0) {
    throw new Error('alp init / alp setup failed');
  }

  if (opts.live) {
    await run.step('W1', 'alp daemon start; paseo plugin add <absolute path>', async () => {
      if (cli('W1', ['daemon', 'start']).status !== 0) throw new Error('alp daemon start failed');
      const added = paseo('W1', ['plugin', 'add', plugin]);
      if (added.error?.code === 'ENOENT') throw new Error('paseo is not on PATH');
      if (added.status !== 0) throw new Error(`paseo plugin add failed: ${(added.stderr || added.stdout).trim().slice(0, 300)}; try the install of scripts/tarball-consumer.mjs and note it`);
      run.record('W1', 'pass', `plugin added from ${plugin}`);
    });

    await run.step('W2', 'paseo plugin ls; paseo provider models alp', async () => {
      const listed = paseo('W2', ['plugin', 'ls']).stdout;
      if (!/alp-provider/.test(listed)) throw new Error('paseo plugin ls does not show alp-provider');
      const models = paseo('W2', ['provider', 'models', 'alp']).stdout;
      if (!/Ph[ởo]/i.test(models) || !/Cafe/i.test(models)) throw new Error(`paseo provider models alp lacks Phở or Cafe: ${models.trim().slice(0, 300)}`);
      run.record('W2', 'pass', 'alp-provider listed; Phở and Cafe offered', { plugins: listed.slice(0, 2000), models: models.slice(0, 2000) });
    });

    await manual(run, 'W3', `In Paseo: new session, provider ALP · Phở, folder ${project}. Send "Đếm chậm từ 1 tới 200, mỗi số một dòng.", press Stop while it streams, then send "Bạn đã dừng ở số mấy?".`,
      'it streams; Stop ends the turn; the next prompt runs');

    await run.step('W4', 'permission question in Paseo (C6 profile)', async () => {
      const original = readFileSync(settingsFile, 'utf8');
      writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), permissions: { profiles: { review: { base: 'read-only', ask: ['Bash(touch *)'], beyondMode: 'ask' } }, agents: { main: 'review' } } }, null, 2));
      try {
        await manual(run, 'W4', `The project now has the C6 profile. In a NEW Paseo session (ALP · Phở, ${project}) send:\n  Tự chạy đúng một lệnh shell này, không giao cho ai: \`touch w4-once.txt\`. Nếu bị từ chối thì báo lại.\nAnswer the question card with "${CHOICES.once.join('" / "')}". Then send the same with w4-deny.txt and answer "${CHOICES.deny.join('" / "')}".`,
          'each time a question card with Allow once and Deny appears in Paseo; the answer reaches the agent, which reports it ran or was refused');
        const once = existsSync(path.join(project, 'w4-once.txt'));
        const deny = existsSync(path.join(project, 'w4-deny.txt'));
        if (run.latest().find(step => step.id === 'W4')?.status === 'pass' && (!once || deny)) run.record('W4', 'fail', `on disk: w4-once.txt ${once ? 'exists' : 'missing'}, w4-deny.txt ${deny ? 'exists' : 'missing'}`);
      } finally { writeFileSync(settingsFile, original); }
    });

    await run.step('W5', 'Tasks panel: add, close, reopen', async () => {
      const before = snapshot(path.join(project, '.alp', 'tasks'));
      await manual(run, 'W5', `In the Tasks panel of the ${project} session: add a task, close it, reopen it.`, 'the panel refreshes after each change');
      const after = snapshot(path.join(project, '.alp', 'tasks'));
      if (run.latest().find(step => step.id === 'W5')?.status === 'pass' && before === after) run.record('W5', 'fail', '.alp/tasks did not change on disk');
    });
  } else {
    for (const id of ['W1', 'W2', 'W3', 'W4', 'W5']) run.record(id, 'skip', 'needs Paseo and a model (--live); permission cards are covered hermetically by integrations/paseo/tests/permissions.test.js and paseo-web.test.js');
  }

  await run.step('W6', 'alp-web-integration --register; alp web --print; the token gate', async () => {
    const register = run.exec('W6', process.execPath, [path.join(plugin, 'server', 'dist', 'main.js'), '--register'], { env, cwd: project });
    if (register.status !== 0) throw new Error(`alp-web-integration --register failed: ${register.stderr.trim().slice(0, 300)}`);
    const printed = cli('W6', ['web', '--print']);
    const url = printed.stdout.trim().split('\n').at(-1);
    const match = /^(http:\/\/127\.0\.0\.1:\d+)\/?#token=([0-9a-f]+)$/.exec(url ?? '');
    if (printed.status !== 0 || !match) throw new Error(`alp web --print gave no loopback address with a token: ${(printed.stderr || printed.stdout).trim().slice(0, 300)}`);
    const [, origin, token] = match;
    const page = await fetch(origin);
    if (page.status !== 200) throw new Error(`GET ${origin} answered ${page.status}`);
    const without = await hello(origin, undefined);
    const wrong = await hello(origin, '0'.repeat(token.length));
    const right = await hello(origin, token);
    const problems = [];
    if (without !== 'rejected:password_required') problems.push(`no token: ${without}`);
    if (wrong !== 'rejected:incorrect_password') problems.push(`wrong token: ${wrong}`);
    if (right !== 'accepted') problems.push(`right token: ${right}`);
    if (problems.length) throw new Error(problems.join('; '));
    run.record('W6', opts.live ? 'check' : 'pass', `${origin} serves the app; the socket refuses no token and a wrong one, accepts alpd's`, { origin });
    if (opts.live) {
      await manual(run, 'W6', `Open ${url} on this machine (Linux headless: ssh -L ${new URL(origin).port}:127.0.0.1:${new URL(origin).port} <host>, then open it on yours).`,
        'the project and the W3 session show; asking and answering and the Tasks panel work');
    }
  });
} catch (error) {
  run.record('acceptance', 'fail', error.message);
} finally {
  if (opts.fake) {
    try { await cleanupFakeWeb(home, () => cli('cleanup', ['daemon', 'stop'])); }
    catch (error) { run.record('cleanup', 'fail', error.message); }
  }
  else console.log('\nalpd and the plugin stay as Paseo uses them. To undo W1: paseo plugin remove alp-provider');
}
process.exit(run.summary());

/** Paseo's hello on alpd's socket, as the app sends it: how alpd answers. */
function hello(origin, password) {
  const WebSocket = createRequire(path.join(consumer, 'package.json'))('ws');
  return new Promise(resolve => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin } });
    const done = result => { clearTimeout(timer); ws.terminate(); resolve(result); };
    const timer = setTimeout(() => done('no answer in 10 s'), 10_000);
    ws.on('unexpected-response', (_request, response) => done(`refused ${response.statusCode}`));
    ws.on('error', error => done(`error ${error.message}`));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', clientId: 'alp-beta-acceptance', clientType: 'browser', protocolVersion: 1, capabilities: { helloRejection: true }, ...(password ? { auth: { kind: 'password', password } } : {}) })));
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'hello.rejected') done(`rejected:${frame.reason}`);
      else if (frame.message?.payload?.status === 'server_info') done('accepted');
    });
  });
}

/** The task files of a project, hashed, to tell whether the panel changed them. */
function snapshot(directory) {
  if (!existsSync(directory)) return '';
  const hash = createHash('sha256');
  for (const file of readdirSync(directory, { recursive: true }).map(String).sort()) {
    const full = path.join(directory, file);
    try { hash.update(file).update(readFileSync(full)); } catch { hash.update(file); }
  }
  return hash.digest('hex');
}
