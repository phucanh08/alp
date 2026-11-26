import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { explainProfile, permissionScopes, profileFor } from '@anhlp/alp-core/permissions';
import { teardown } from '../../../test/support/teardown.ts';

async function fixture(t) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-scopes-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  await mkdir(home);
  const projectFile = path.join(root, '.alp', 'settings.json');
  const userFile = path.join(home, 'settings.json');
  /** Writes each scope's `permissions`; `undefined` leaves the scope without a settings file. */
  const write = async (project, user) => {
    for (const [file, permissions] of [[projectFile, project], [userFile, user]]) {
      if (permissions === undefined) await rm(file, { force: true });
      else await writeFile(file, JSON.stringify({ permissions }));
    }
  };
  return { root, home, projectFile, userFile, write };
}

/** What a call settles to, in a form two calls can be compared by: the exact JSON text, or the error. */
async function settled(promise) {
  try { return { value: JSON.stringify(await promise) }; }
  catch (error) { return { error: { code: error.code, message: error.message } }; }
}

// One scope's `permissions`. Together they cover: no file, no mapping, a mapping to a defined profile,
// to a bare base name, to a profile nobody or only the other scope defines, every base, rules that
// overlap between scopes, beyondMode, workdir copy (valid and not), and the advisors.
const SCOPES = [
  undefined,
  {},
  { agents: { peer: 'dev' }, profiles: { dev: { base: 'full-access', allow: ['Bash(npm test:*)', 'Edit(src/**)'], deny: ['Bash(rm:*)'], beyondMode: 'ask' } } },
  { agents: { peer: 'dev' }, profiles: { dev: { base: 'read-only', allow: ['Bash(npm test:*)'], ask: ['Bash(git push *)'], deny: ['Bash(curl:*)'] } } },
  { agents: { peer: 'tight' }, profiles: { tight: { base: 'workspace-write', deny: ['Bash(git push:*)'], ask: ['WebFetch'] } } },
  { profiles: { dev: { base: 'workspace-write', deny: ['Bash(sudo:*)'], beyondMode: 'refuse' }, tight: { allow: ['Read'] } } },
  { agents: { peer: 'dev' }, profiles: { dev: { allow: ['Bash(ls)'] } } },
  { agents: { peer: 'full-access', reviewer: 'read-only', main: 'workspace-write' } },
  { agents: { peer: 'read-only' }, profiles: { 'read-only': { allow: ['Bash(git status)'] } } },
  { agents: { peer: 'missing', reviewer: 'missing' } },
  { agents: { peer: 'copy', reviewer: 'copy' }, profiles: { copy: { base: 'read-only', workdir: 'copy', allow: ['Bash(npm test *)'] } } },
  { agents: { peer: 'copy' }, profiles: { copy: { workdir: 'copy' } } },
  { agents: { reviewer: 'review', oracle: 'wide' }, profiles: { review: { allow: ['Bash(npm test:*)'], beyondMode: 'ask' }, wide: { base: 'full-access' } } },
  { agents: { reviewer: 'dev', constructor: 'dev' }, profiles: { dev: { base: 'read-only', deny: ['Bash(rm:*)'] } } },
];
const AGENTS = ['peer', 'main', 'reviewer', 'oracle', 'constructor', 'unknown'];

test('the per-scope resolver gives exactly what profileFor gives, for every pair of scopes, agent and role', async t => {
  const { root, home, write } = await fixture(t);
  let compared = 0;
  let profiles = 0;
  let errors = 0;
  for (const project of SCOPES) {
    for (const user of SCOPES) {
      await write(project, user);
      for (const agent of AGENTS) {
        for (const readOnly of [false, true]) {
          // Without a home there is no user scope at all.
          for (const withHome of [home, undefined]) {
            const where = JSON.stringify({ project, user, agent, readOnly, home: Boolean(withHome) });
            const enforced = await settled(profileFor(root, withHome, agent, { readOnly }));
            const explained = await settled(explainProfile(root, withHome, agent, { readOnly }).then(result => result.profile));
            assert.deepEqual(explained, enforced, where);
            compared++;
            if (enforced.error) errors++;
            else if (enforced.value !== 'null') profiles++;
          }
        }
      }
    }
  }
  // The matrix must reach all three outcomes, or it proves less than it says.
  assert.equal(compared, SCOPES.length * SCOPES.length * AGENTS.length * 4);
  assert.ok(profiles > 500 && errors > 100 && compared - profiles - errors > 100, `profiles ${profiles}, errors ${errors}, of ${compared}`);
});

test('every value and rule names the scope and file it came from', async t => {
  const { root, home, projectFile, userFile, write } = await fixture(t);
  await write(
    { agents: { peer: 'dev' }, profiles: { dev: { base: 'full-access', allow: ['Bash(npm test:*)', 'Edit(src/**)'], beyondMode: 'ask' } } },
    { agents: { peer: 'dev' }, profiles: { dev: { base: 'workspace-write', allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] } } },
  );
  const project = { scope: 'project', file: projectFile };
  const user = { scope: 'user', file: userFile };
  const result = await explainProfile(root, home, 'peer');
  assert.deepEqual(result.profile, await profileFor(root, home, 'peer'));
  assert.deepEqual(result.provenance, {
    name: { value: 'dev', ...project, key: 'permissions.agents.peer', overrides: [{ ...user, value: 'dev' }] },
    base: { value: 'full-access', ...project, key: 'permissions.profiles.dev.base' },
    beyondMode: { value: 'ask', ...project, key: 'permissions.profiles.dev.beyondMode' },
    allow: [{ rule: 'Bash(npm test:*)', sources: [project, user] }, { rule: 'Edit(src/**)', sources: [project] }],
    ask: [],
    deny: [{ rule: 'Bash(rm:*)', sources: [user] }],
  });
  assert.deepEqual(result.scopes, [
    { ...project, exists: true, agentProfile: 'dev', profile: { base: 'full-access', beyondMode: 'ask', allow: ['Bash(npm test:*)', 'Edit(src/**)'], ask: [], deny: [] } },
    { ...user, exists: true, agentProfile: 'dev', profile: { base: 'workspace-write', allow: ['Bash(npm test:*)'], ask: [], deny: ['Bash(rm:*)'] } },
  ]);
  // The project's base is higher, one allow rule is the project's alone, and the project turns asking on.
  assert.deepEqual(result.warnings.map(warning => warning.code), ['project-base-higher', 'project-allow-rules', 'project-beyond-mode']);
  assert.deepEqual(result.warnings[0], {
    code: 'project-base-higher', agent: 'peer', project: 'full-access', user: 'workspace-write',
    message: `the project sets base full-access (permissions.profiles.dev.base in ${projectFile}); your settings say workspace-write (${userFile}). The project's value applies.`,
  });
  assert.deepEqual(result.warnings[1].rules, ['Edit(src/**)']);
});

test('defaults, bare base names and the user scope are told apart', async t => {
  const { root, home, projectFile, userFile, write } = await fixture(t);
  // Nothing maps the agent: no profile, nothing to explain, nothing to warn about.
  await write(undefined, undefined);
  assert.deepEqual(await explainProfile(root, home, 'peer'), {
    agent: 'peer', profile: null, provenance: null, warnings: [],
    scopes: [{ scope: 'project', file: projectFile, exists: false }, { scope: 'user', file: userFile, exists: false }],
  });
  assert.deepEqual((await permissionScopes(root, undefined)).map(scope => scope.scope), ['project']);
  // An advisor without a mapping is read-only by default, from no file.
  const advisor = await explainProfile(root, home, 'reviewer');
  assert.deepEqual(advisor.provenance.base, { value: 'read-only', scope: 'default', reason: 'reviewer is an advisor' });
  assert.deepEqual(advisor.warnings, []);
  // The user's own settings alone never warn, whatever they grant.
  await write(undefined, { agents: { peer: 'full-access', main: 'dev' }, profiles: { dev: { allow: ['Bash(make:*)'], beyondMode: 'ask' } } });
  const bare = await explainProfile(root, home, 'peer');
  assert.deepEqual(bare.provenance.base, { value: 'full-access', scope: 'user', file: userFile, key: 'permissions.agents.peer', reason: 'a bare base name' });
  assert.deepEqual(bare.warnings, []);
  const main = await explainProfile(root, home, 'main');
  assert.deepEqual(main.provenance.base, { value: 'full-access', scope: 'default', reason: "profile 'dev' sets no base" });
  assert.deepEqual(main.provenance.allow, [{ rule: 'Bash(make:*)', sources: [{ scope: 'user', file: userFile }] }]);
  assert.deepEqual(main.warnings, []);
  // A project that only restricts (a lower base, deny and ask rules) does not warn either.
  await write({ agents: { peer: 'dev' }, profiles: { dev: { base: 'read-only', deny: ['Bash(rm:*)'], ask: ['Bash(git push *)'] } } }, { agents: { peer: 'full-access' } });
  assert.deepEqual((await explainProfile(root, home, 'peer')).warnings, []);
});

test('warnings say what the project gives beyond the user scope, and never change the profile', async t => {
  const { root, home, write } = await fixture(t);
  const codes = async (agent, options) => {
    const result = await explainProfile(root, home, agent, options);
    assert.deepEqual(result.profile, await profileFor(root, home, agent, options));
    return result.warnings.map(warning => warning.code);
  };
  // A bare base name in the project above the user's bare base name.
  await write({ agents: { peer: 'full-access' } }, { agents: { peer: 'read-only' } });
  assert.deepEqual(await codes('peer'), ['project-base-higher']);
  // The user never maps the agent, yet defines the same profile with a lower base: the project's wins.
  await write({ agents: { peer: 'dev' }, profiles: { dev: { base: 'workspace-write' } } }, { profiles: { dev: { base: 'read-only' } } });
  assert.deepEqual(await codes('peer'), ['project-base-higher']);
  // The same base is not higher; the user's own base, used because the project sets none, is not the project's.
  await write({ agents: { peer: 'dev' }, profiles: { dev: { base: 'read-only' } } }, { profiles: { dev: { base: 'read-only' } } });
  assert.deepEqual(await codes('peer'), []);
  await write({ agents: { peer: 'dev' }, profiles: { dev: {} } }, { profiles: { dev: { base: 'full-access' } } });
  assert.deepEqual(await codes('peer'), []);
  // A read-only role caps the base; the warning still names what the project asked for.
  await write({ agents: { peer: 'full-access' } }, { agents: { peer: 'read-only' } });
  const capped = await explainProfile(root, home, 'peer', { readOnly: true });
  assert.equal(capped.profile.base, 'read-only');
  assert.equal(capped.provenance.base.cappedFrom, 'full-access');
  assert.match(capped.warnings[0].message, /sets base full-access .* capped to read-only by the member's read-only role\.$/);
  // The project maps the agent to another profile than the user's: the user's deny and ask rules are not loaded.
  await write(
    { agents: { peer: 'wide' }, profiles: { wide: { base: 'full-access' } } },
    { agents: { peer: 'tight' }, profiles: { tight: { base: 'workspace-write', deny: ['Bash(git push:*)'], ask: ['WebFetch'] } } },
  );
  assert.deepEqual(await codes('peer'), ['project-base-higher', 'user-deny-not-applied', 'user-ask-not-applied']);
  const dropped = (await explainProfile(root, home, 'peer')).warnings[1];
  assert.deepEqual(dropped.rules, ['Bash(git push:*)']);
  assert.match(dropped.message, /^the project maps peer to profile wide .*so the deny rule of your profile tight .* does not apply: Bash\(git push:\*\)\.$/);
  // Allow rules for an advisor that only the project gives; without a user settings file too.
  await write({ agents: { reviewer: 'review' }, profiles: { review: { allow: ['Bash(npm test:*)'] } } }, undefined);
  assert.deepEqual(await codes('reviewer'), ['project-allow-rules']);
  // Without a home there is no user scope to compare with.
  assert.deepEqual((await explainProfile(root, undefined, 'reviewer')).warnings, []);
});
