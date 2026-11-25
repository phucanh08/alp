import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { profileFor } from '@anhlp/alp-core/permissions';
import { teardown } from '../../../test/support/teardown.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function project(t, permissions, userPermissions) {
  const defer = teardown(t);
  // Resolved: the CLI names the project by its working directory, which the system reports without links (/tmp on macOS).
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-config-')));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  await initProject(root);
  await mkdir(home, { recursive: true });
  const projectFile = path.join(root, '.alp', 'settings.json');
  const userFile = path.join(home, 'settings.json');
  if (permissions) await writeFile(projectFile, JSON.stringify({ ...JSON.parse(await readFile(projectFile, 'utf8')), permissions }));
  if (userPermissions) await writeFile(userFile, JSON.stringify({ permissions: userPermissions }));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home, HOME: directory, USERPROFILE: directory } });
  return { root, home, projectFile, userFile, run };
}

test('alp config explain names the file and scope of each value and warns, without failing, when the project is wider', async t => {
  const { root, home, projectFile, userFile, run } = await project(
    t,
    { agents: { peer: 'dev' }, profiles: { dev: { base: 'full-access', allow: ['Bash(npm test:*)', 'Edit(src/**)'], beyondMode: 'ask' } } },
    { agents: { peer: 'dev', reviewer: 'review' }, profiles: { dev: { base: 'workspace-write', allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] }, review: { base: 'read-only', ask: ['Bash(git push *)'] } } },
  );
  const before = [await readFile(projectFile, 'utf8'), await readFile(userFile, 'utf8')];
  const result = run('config', 'explain');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['Permission settings, in the order ALP reads them (the project first):', `  project ${projectFile}`, `  user    ${userFile}`]);
  const peer = lines.slice(lines.indexOf('peer'), lines.indexOf('', lines.indexOf('peer')));
  assert.deepEqual(peer, [
    'peer',
    `  profile     dev          project  ${projectFile}  (permissions.agents.peer)`,
    `                           overrides dev from user  ${userFile}`,
    `  base        full-access  project  ${projectFile}  (permissions.profiles.dev.base)`,
    `  beyondMode  ask          project  ${projectFile}  (permissions.profiles.dev.beyondMode)`,
    `  allow Bash(npm test:*)  project  ${projectFile} + user  ${userFile}`,
    `  allow Edit(src/**)  project  ${projectFile}`,
    `  deny  Bash(rm:*)  user  ${userFile}`,
    `  warning: the project sets base full-access (permissions.profiles.dev.base in ${projectFile}); your settings say workspace-write (${userFile}). The project's value applies.`,
    `  warning: the project adds an allow rule your settings do not have (${projectFile}): Edit(src/**). It applies, also beyond the agent's mode.`,
    `  warning: the project sets beyondMode ask (permissions.profiles.dev.beyondMode in ${projectFile}): what the agent's mode refuses is asked instead, and may be allowed always.`,
  ]);
  // The user's own grant is explained and does not warn.
  const reviewer = lines.slice(lines.indexOf('reviewer'), lines.indexOf('', lines.indexOf('reviewer')));
  assert.deepEqual(reviewer, [
    'reviewer',
    `  profile     review     user  ${userFile}  (permissions.agents.reviewer)`,
    `  base        read-only  user  ${userFile}  (permissions.profiles.review.base)`,
    '  beyondMode  refuse     default',
    `  ask   Bash(git push *)  user  ${userFile}`,
  ]);
  // An agent nothing maps keeps the default, and says so.
  assert.equal(lines[lines.indexOf('main') + 1], '  no profile: no settings file maps main to one; the mode its requester or the user chooses applies (default)');
  assert.match(lines.at(-2), /^3 warnings: the project's settings give more than your own settings do\. They apply as written; ALP only reports them\./);

  // --json carries the same, and the profile is the one ALP enforces.
  const json = run('config', 'explain', '--agent', 'peer', '--json');
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.scopes, [{ scope: 'project', file: projectFile, exists: true }, { scope: 'user', file: userFile, exists: true }]);
  assert.deepEqual(parsed.agents.map(row => row.agent), ['peer']);
  assert.deepEqual(parsed.agents[0].profile, await profileFor(root, home, 'peer'));
  assert.deepEqual(parsed.agents[0].provenance.base, { value: 'full-access', scope: 'project', file: projectFile, key: 'permissions.profiles.dev.base' });
  assert.deepEqual(parsed.warnings.map(warning => warning.code), ['project-base-higher', 'project-allow-rules', 'project-beyond-mode']);
  // Explaining reads only.
  assert.deepEqual([await readFile(projectFile, 'utf8'), await readFile(userFile, 'utf8')], before);
});

test('alp config explain without user settings explains the project and the defaults; a broken file is an error, not a warning', async t => {
  const { projectFile, userFile, run } = await project(t, { agents: { peer: 'workspace-write' } });
  const result = run('config', 'explain', '--agent', 'peer', '--agent', 'reviewer');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n'), [
    'Permission settings, in the order ALP reads them (the project first):',
    `  project ${projectFile}`,
    `  user    ${userFile}  (no such file)`,
    '',
    'peer',
    `  profile     workspace-write  project  ${projectFile}  (permissions.agents.peer)`,
    `  base        workspace-write  project  ${projectFile}  (permissions.agents.peer; a bare base name)`,
    '  beyondMode  refuse           default',
    '',
    'reviewer',
    '  profile     read-only  default  (reviewer is an advisor)',
    '  base        read-only  default  (reviewer is an advisor)',
    '  beyondMode  refuse     default',
    '',
  ]);
  assert.equal(run('config').status, 1);
  assert.equal(run('config', 'explain', 'extra').status, 1);
  // A mapping to a profile no file defines: the agent could not start, so this is an error for that agent only.
  await writeFile(projectFile, JSON.stringify({ ...JSON.parse(await readFile(projectFile, 'utf8')), permissions: { agents: { peer: 'missing' } } }));
  const broken = run('config', 'explain', '--agent', 'peer', '--agent', 'main');
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /\npeer\n  error: permissions\.agents\.peer names profile 'missing', which no settings file defines\n\nmain\n  no profile:/);
});
