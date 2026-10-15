import { parseArgs } from 'node:util';
import { initProject } from '@anhlp/alp-core/init';
import { upgradeProject } from '@anhlp/alp-core/upgrade';
import { seedLibrary } from '@anhlp/alp-core/library';
import { commandDecision, profileFor } from '@anhlp/alp-core/permissions';
import { describeVerification, runVerify, verifyConfig } from '@anhlp/alp-core/verify';
import { diagnose, repair } from '@anhlp/alp-client/doctor';
import { discoverAgents } from '@anhlp/alp-core/resolver';
import { probeAntigravity } from '@anhlp/alp-client/antigravity-probe';
import { isTrusted, revokeProject, trustProject, trustedProjects } from '@anhlp/alp-core/trust';
import { getTask, recordVerification } from '@anhlp/alp-core/tasks';
import { alpHome } from '@anhlp/alp-client/index';
import { languageSetting, setLanguage } from '@anhlp/alp-core/user-settings';
import { UsageError } from './usage.js';
import { taskProject } from './tasks.js';
import { DAEMON_ENTRY } from './paths.js';

const DOCTOR_MARK = { ok: '✓', info: '·', warn: '!', fail: '✗' };

async function project(command, args) {
  if (args.length > 1) throw new UsageError();
  try {
    const result = await (command === 'upgrade' ? upgradeProject : initProject)(args[0] ?? process.cwd(), { library: alpHome() });
    console.log(`ALP initialized: ${result.created.length} files created, ${result.preserved.length} existing files preserved.`);
    const library = await seedLibrary(alpHome());
    if (library.created.length || library.updated.length) console.log(`Skill library ${alpHome()}: ${library.created.length} files added, ${library.updated.length} unchanged files updated.`);
    if (command === 'init' && result.updated?.length) console.log(`Template model profiles refreshed: ${result.updated.join(', ')}`);
    if (command === 'upgrade') {
      console.log(`ALP upgraded: ${result.updated.length} files updated.${result.backup ? ` Backup: ${result.backup}` : ''}`);
      if (result.customInstructions.length) console.log(`Custom instructions preserved; reconcile with templates if needed: ${result.customInstructions.join(', ')}`);
      const copies = result.removed.filter(name => /^\.alp\/agents\/[^/]+$/.test(name));
      const skills = result.removed.filter(name => !copies.includes(name));
      if (skills.length) console.log(`Retired skills archived: ${skills.join(', ')}`);
      if (copies.length) console.log(`Unedited agent copies put away; the project now uses ALP's built-ins: ${copies.join(', ')}`);
      if (result.customSkills.length) console.log(`Customized retired skills preserved for review: ${result.customSkills.join(', ')}`);
    }
  } catch (error) {
    console.error(`ALP initialization failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function permissionsCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  const root = await taskProject(values.project);
  if (positionals[0] === 'check') {
    if (positionals.length !== 3) throw new UsageError();
    const profile = await profileFor(root, alpHome(), positionals[1]);
    const decision = profile ? commandDecision(profile, positionals[2]) : undefined;
    const result = { agent: positionals[1], profile: profile?.name ?? null, base: profile?.base ?? null, decision: decision ?? 'mode' };
    if (values.json) { console.log(JSON.stringify(result)); return; }
    console.log(decision === 'deny' ? `deny: a deny rule of profile ${profile.name} covers it`
      : decision === 'ask' ? `ask: profile ${profile.name} asks the user each time`
      : decision === 'allow' ? `allow: profile ${profile.name} lets ${result.agent} run it, even beyond its ${profile.base} mode`
      : `no rule covers it: ${result.agent}'s mode decides${profile ? ` (at most ${profile.base})` : ''}`);
    return;
  }
  if (positionals.length) throw new UsageError();
  const rows = [];
  for (const agent of await discoverAgents(root, { library: alpHome() })) rows.push({ agent, profile: await profileFor(root, alpHome(), agent) });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  for (const { agent, profile } of rows) {
    console.log(profile ? `${agent}  profile ${profile.name}, at most ${profile.base}${profile.beyondMode === 'ask' ? '; asks the user beyond it' : ''}` : `${agent}  no profile: the mode its requester or the user chooses`);
    if (profile?.allow.length) console.log(`  allow: ${profile.allow.join(', ')}`);
    if (profile?.ask.length) console.log(`  ask:   ${profile.ask.join(', ')}`);
    if (profile?.deny.length) console.log(`  deny:  ${profile.deny.join(', ')}`);
  }
}

/** Lists one library kind: where each entry comes from, what it overrides, and who uses it. */

async function trustCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, revoke: { type: 'boolean' }, list: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length || (values.revoke && values.list)) throw new UsageError();
  if (values.list) {
    const rows = await trustedProjects(alpHome());
    if (values.json) console.log(JSON.stringify(rows));
    else console.log(rows.length ? rows.map(row => `${row.root}  since ${row.trustedAt.slice(0, 10)} (${row.by})`).join('\n') : 'No workspace is trusted yet; ALP asks before a project\'s hooks first run.');
    return;
  }
  const root = await taskProject(values.project);
  if (values.revoke) {
    const was = await revokeProject(alpHome(), root);
    console.log(was ? `ALP asks again before the hooks of ${root} run.` : `${root} was not trusted.`);
    return;
  }
  if (await isTrusted(alpHome(), root)) { console.log(`${root} is already trusted.`); return; }
  await trustProject(alpHome(), root, 'alp trust');
  console.log(`The hooks of ${root} now run without asking, including hooks added or changed later.`);
}

/** alp teams: each team with where it comes from, its main, members and delegation. */

async function language(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reset: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length > 1 || (values.reset && positionals.length)) throw new UsageError();
  const state = values.reset ? await setLanguage(alpHome(), null) : positionals.length ? await setLanguage(alpHome(), positionals[0]) : await languageSetting(alpHome());
  if (values.json) console.log(JSON.stringify(state));
  else console.log(state.language ? `Language: ${state.language}` : `Language: ${state.applies} (the default; not set)`);
}

/** alp verify: run the project's verify commands here, in the project root. */

async function verify(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, task: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals[0] === 'antigravity') {
    const result = await probeAntigravity({}, { cwd: process.cwd() });
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`Antigravity ${result.version || 'installed'}: ok (${result.models.length} models)`);
    return;
  }
  if (positionals.length) throw new UsageError();
  const root = await taskProject(values.project);
  const config = await verifyConfig(root);
  if (!config) throw new Error(`${root} has no verify commands; add "verify": { "test": "npm test" } to .alp/settings.json`);
  if (values.task) await getTask(root, values.task);
  const verification = await runVerify(root, config);
  if (values.task) await recordVerification(root, values.task, { ...verification, where: 'checkout' }, 'user');
  if (values.json) console.log(JSON.stringify(verification));
  else {
    for (const command of verification.commands) {
      console.log(`${command.exitCode === 0 ? '✓' : '✗'} ${command.step}: ${command.command}  (${(command.ms / 1000).toFixed(1)} s${command.timedOut ? ', timed out' : command.exitCode ? `, exit ${command.exitCode}` : ''})`);
      if (command.exitCode !== 0 && command.output) console.log(`  ${command.output.trimEnd().split('\n').slice(-30).join('\n  ')}`);
    }
    console.log(`${describeVerification(verification)}${values.task ? `; recorded on ${values.task}` : ''}`);
  }
  if (!verification.passed) process.exitCode = 1;
}

async function doctor(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, fix: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const project = values.project ? await taskProject(values.project) : await taskProject(undefined).catch(() => undefined);
  const sandbox = await import('../dist/runtime/index.js').then(runtime => runtime.claudeSandboxAvailable(), () => undefined);
  const options = { home: alpHome(), project, sandbox, daemonEntry: DAEMON_ENTRY };
  let checks = await diagnose(options);
  const fixed = values.fix ? await repair(checks) : [];
  if (fixed.length) checks = await diagnose(options);
  if (values.json) {
    console.log(JSON.stringify({ project: project ?? null, checks: checks.map(({ fix, ...check }) => ({ ...check, ...(fix ? { fix: fix.describe } : {}) })), fixed }));
  } else {
    for (const { id, result } of fixed) console.log(`fixed ${id}: ${result}`);
    if (fixed.length) console.log('');
    for (const check of checks) {
      console.log(`${DOCTOR_MARK[check.status]} ${check.id.padEnd(13)} ${check.summary}`);
      for (const detail of check.details ?? []) console.log(`    ${detail}`);
      if (check.fix) console.log(`    --fix: ${check.fix.describe}`);
      if (check.hint) console.log(`    ${check.hint}`);
    }
    const failed = checks.filter(check => check.status === 'fail').length;
    const warned = checks.filter(check => check.status === 'warn').length;
    const fixable = checks.filter(check => check.fix).length;
    console.log(`\n${failed || warned ? `${failed} failed, ${warned} to look at` : 'All good'}${project ? '' : ' (no ALP project here; pass --project to check one)'}${fixable ? `; alp doctor --fix repairs ${fixable}` : ''}`);
  }
  if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
}

/** alp recall: ask a finished assignment, or the last one on a task, what it did and why. */

export { project, permissionsCommand, trustCommand, language, verify, doctor };
