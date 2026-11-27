// What `alp doctor` reports, in order, for one home that trips most finding groups at once:
// build, runtimes, home, disk, alpd, service, state, schema, migration, restore, log, failed
// sessions, sandbox, permissions, user settings, skills, skill format, providers, live work and
// the project's settings and agents. The checks run against a private directory with a fake
// command runner, so no runtime, git or alpd is started and the real home is not read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { STATE_SCHEMA, migrationFile } from '@anhlp/alp-core/state-schema';
import { diagnose } from '../dist/diagnostics/doctor.js';
import { serviceFor } from '../dist/daemon/service.js';
import type { CommandRunner, DoctorCheck } from '../dist/diagnostics/doctor.js';

const windows = process.platform === 'win32';

/** The order of the finding ids is the contract on every platform. */
const ORDER = [
  'build', 'codex', 'claude', 'antigravity', 'home', 'disk', 'alpd', 'service', 'state', 'schema', 'migration', 'restore',
  'startup', 'persistence log', 'ipc log', 'provider log', 'failed sessions', 'sandbox', 'permissions', 'user settings',
  'skills', 'skill-format', 'providers', 'live work', 'settings', 'agents', 'agents',
];

const line = (value: unknown) => JSON.stringify({ time: '2026-01-01T00:00:00.000Z', component: 'alpd', ...(value as object) });

test('alp doctor lists its findings in a fixed order with fixed wording', async t => {
  // The modes the permissions check lists are the ones files get under the usual umask.
  const umask = process.umask(0o022);
  t.after(() => { process.umask(umask); });
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-order-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const real = await realpath(directory);
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  const services = path.join(directory, 'services');
  const bin = path.join(directory, 'bin');
  for (const dir of [path.join(home, 'state', 'sessions'), path.join(home, 'logs'), path.join(home, 'skills', 'tidy'), path.join(home, 'providers'), services, bin, project]) await mkdir(dir, { recursive: true });
  const codex = path.join(bin, 'codex');
  const claude = path.join(bin, 'claude');
  for (const file of [codex, claude]) { await writeFile(file, ''); await chmod(file, 0o755); }

  // alpd: a lock and socket left by an alpd that is gone, which stopped unexpectedly.
  await writeFile(path.join(home, 'alpd.lock'), 'not json');
  await writeFile(path.join(home, 'state', 'alpd.running'), '{}');
  // The installed service runs files that are gone.
  const env = { PATH: path.join(directory, 'empty'), ALP_CODEX_BIN: codex, ALP_CLAUDE_BIN: claude, ALP_SERVICE_DIR: services };
  const service = serviceFor({ home, env });
  if (service) {
    const gone = [path.join(directory, 'gone', 'node'), path.join(directory, 'gone', 'alpd.js')];
    await writeFile(service.file, service.kind === 'launchd'
      ? `<plist><dict><key>ProgramArguments</key><array>${gone.map(file => `<string>${file}</string>`).join('')}</array></dict></plist>\n`
      : `[Service]\nExecStart=${gone.map(file => JSON.stringify(file)).join(' ')}\n`);
  }
  // State: one unreadable record and one session that failed long ago; a migration and a restore cut short.
  await writeFile(path.join(home, 'state', 'sessions', 'bad.json'), '{"version": 1, "id": ');
  await writeFile(path.join(home, 'state', 'sessions', 's1.tmp'), '');
  await writeFile(path.join(home, 'state', 'sessions', 's2.json'), JSON.stringify({
    version: 1, id: 's2', status: 'failed', updatedAt: '2026-01-01T00:00:00.000Z', session: { agent: 'peer', runtime: 'codex' },
    lastError: { code: 'login_required', message: 'codex says: log in' },
  }));
  await writeFile(migrationFile(home), '{}');
  await writeFile(path.join(home, 'restore-journal.json'), '{}');
  // alpd's log: problems since it was last ready, and the start that failed.
  await writeFile(path.join(home, 'logs', 'alpd.log'), [
    line({ level: 'info', msg: 'alpd ready', event: 'ready' }),
    line({ level: 'error', code: 'ALP_PERSISTENCE_WRITE_FAILED', msg: 'record s1 failed', sessionId: 's1' }),
    line({ level: 'warn', code: 'ALP_IPC_PARSE_ERROR', component: 'alpd.ipc', msg: 'a client sent a line that is not JSON' }),
    line({ level: 'error', code: 'ALP_PROVIDER_FAILED', component: 'runtime', msg: 'the codex session failed', sessionId: 's2' }),
    line({ level: 'error', code: 'ALP_IPC_LISTEN_FAILED', msg: 'alpd failed to start', error: { name: 'Error', code: 'EADDRINUSE', message: 'listen EADDRINUSE' } }),
    '',
  ].join('\n'));
  // Library: a settings key ALP ignores, a role skill that is missing, a skill to check, an ACP provider whose command is missing.
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ notASetting: true }));
  await writeFile(path.join(home, 'role-skills.json'), JSON.stringify({ peer: ['absent'] }));
  await writeFile(path.join(home, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidies things.\n---\n\nTidy.\n');
  await writeFile(path.join(home, 'providers', 'acme.json'), JSON.stringify({ kind: 'acp', command: 'acme-agent' }));
  // Live work of a project that no longer exists.
  await writeFile(path.join(home, 'state', 'live.json'), JSON.stringify([{ project: path.join(directory, 'vanished'), agent: 'peer', assignmentId: 'a1' }]));
  await chmod(home, 0o755);
  // The project: a default agent it does not have.
  await initProject(project);
  const settings = path.join(project, '.alp', 'settings.json');
  await writeFile(settings, JSON.stringify({ ...JSON.parse(await readFile(settings, 'utf8')), defaultAgent: 'nobody' }));

  const run: CommandRunner = async (command, args) => {
    if (command === codex && args[0] === '--version') return { code: 0, stdout: 'codex-cli 9.9.9\n', stderr: '' };
    if (command === codex) return { code: 1, stdout: 'Not logged in\n', stderr: '' };
    if (command === claude && args[0] === '--version') return { code: 0, stdout: '9.9.9 (Claude Code)\n', stderr: '' };
    if (command === claude) return { code: 0, stdout: '{"loggedIn": true}\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'not here' };
  };
  const checks: DoctorCheck[] = await diagnose({ home, project, env, run, sandbox: true, daemonEntry: path.join(directory, 'alpd.js'), timeoutMs: 200 });

  assert.deepEqual(checks.map(check => check.id), windows ? ORDER.filter(id => id !== 'service') : ORDER);
  if (windows) return;

  const normalize = (text: string) => text.split(real).join('<dir>').split(directory).join('<dir>')
    .split(service?.name ?? '\0').join('<service>').split(service?.kind ?? '\0').join('<kind>');
  const render = (check: DoctorCheck): string => {
    // What depends on the machine: free space, the temp directory's leftovers and ALP's built-in agents.
    if (check.id === 'disk') return 'disk <machine>';
    const summary = check.id === 'agents' && check.status === 'ok' ? check.summary.replace(/^\d+ agents resolve: .*/, '<n> agents resolve: <agents>')
      : check.id === 'schema' ? check.summary.split(`to ${STATE_SCHEMA} `).join('to <schema> ')
      : check.summary;
    return [
      `${check.id} ${check.status}: ${summary}`,
      ...(check.details ?? []).map(detail => `  - ${detail}`),
      ...(check.hint ? [`  hint: ${check.hint}`] : []),
      ...(check.fix ? [`  fix: ${check.fix.describe}`] : []),
    ].map(normalize).join('\n');
  };
  const text = checks.map(render).join('\n') + '\n';
  const file = fileURLToPath(new URL('./golden/doctor.txt', import.meta.url));
  if (process.env.ALP_UPDATE_GOLDEN === '1') { await writeFile(file, text); return; }
  assert.equal(text, await readFile(file, 'utf8'), 'alp doctor output differs from tests/golden/doctor.txt; if the change is intended, run with ALP_UPDATE_GOLDEN=1');
});
