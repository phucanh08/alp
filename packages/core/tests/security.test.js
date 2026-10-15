import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profileFor } from '../src/permissions.js';
import { createTask, loadTasks } from '../src/tasks.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.alp'));
  return root;
}
for (const name of ['constructor', 'toString', '__proto__']) {
  test(`security: inherited profile ${name} never grants permissions`, async t => {
    const root = await fixture(t);
    const file = path.join(root, '.alp/settings.json');
    await writeFile(file, JSON.stringify({ permissions: { agents: { peer: name } } }));
    await assert.rejects(profileFor(root, undefined, 'peer'), { code: 'INVALID_SETTINGS' });
    await writeFile(file, JSON.stringify({ permissions: { agents: { peer: name }, profiles: { [name]: { base: 'read-only' } } } }));
    assert.equal((await profileFor(root, undefined, 'peer')).base, 'read-only');
    assert.equal(await profileFor(root, undefined, 'constructor'), null);
  });
}
for (const segment of ['.alp', '.alp/tasks']) {
  test(`security: task storage rejects ${segment} symlink before read or creation`, async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    const link = path.join(root, segment);
    if (segment === '.alp') await rm(link, { recursive: true });
    await symlink(outside, link);
    const before = await readdir(outside);
    await assert.rejects(loadTasks(root), { code: 'UNSAFE_PATH' });
    await assert.rejects(createTask(root, { title: 'Must not escape' }, 'user'), { code: 'UNSAFE_PATH' });
    assert.deepEqual(await readdir(outside), before);
  });
}
test('security: task file symlink is rejected without exposing outside data', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const file = path.join(outside, 'private.json');
  const body = JSON.stringify({ id: 't-1234', title: 'PRIVATE', status: 'open' });
  await writeFile(file, body);
  await mkdir(path.join(root, '.alp/tasks'));
  await symlink(file, path.join(root, '.alp/tasks/t-1234.json'));
  await assert.rejects(loadTasks(root), { code: 'UNSAFE_PATH' });
  await assert.rejects(createTask(root, { title: 'Must not create' }, 'user'), { code: 'UNSAFE_PATH' });
  assert.equal(await readFile(file, 'utf8'), body);
  assert.deepEqual(await readdir(path.join(root, '.alp/tasks')), ['t-1234.json']);
});

test('security: first-use library and settings create private ALP_HOME', { skip: process.platform === 'win32' }, async t => {
  const { seedLibrary } = await import('../src/library.js');
  const { setLanguage } = await import('../src/user-settings.js');
  const { saveEntry } = await import('../src/library-edit.js');
  const { stat } = await import('node:fs/promises');
  const root = await fixture(t);
  const actions = [
    home => seedLibrary(home, { templates: { 'role-skills.json': '{}' } }),
    home => setLanguage(home, 'English'),
    home => saveEntry('skills', 'example', { body: 'Example' }, { scope: 'library', library: home }),
  ];
  for (const [i, action] of actions.entries()) {
    const home = path.join(root, `home-${i}`);
    await action(home);
    assert.equal((await stat(home)).mode & 0o077, 0);
  }
});
