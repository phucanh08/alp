import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dashboardSettings, migrateDashboardSettings } from '../src/user-settings.js';
import { validateUserSettings } from '../src/validation.js';

test('dashboard.* is validated like web.* was, and web keeps the relay', () => {
  validateUserSettings({ dashboard: { enabled: false, port: 7433, permissions: ['files.read'] }, web: { relay: { enabled: false } } }, 'settings.json');
  assert.throws(() => validateUserSettings({ dashboard: { port: 80 } }, 'settings.json'), /dashboard\.port must be a port from 1024/);
  assert.throws(() => validateUserSettings({ dashboard: { enabled: 'no' } }, 'settings.json'), /dashboard\.enabled must be true or false/);
  assert.throws(() => validateUserSettings({ dashboard: { relay: {} } }, 'settings.json'), /unsupported dashboard field 'relay'/);
  // A file written for 0.0.1-beta.8 stays valid.
  validateUserSettings({ web: { enabled: true, port: 7433, permissions: [], relay: { enabled: true } } }, 'settings.json');
});

test('dashboardSettings reads dashboard.* first, then web.* from before the rename', () => {
  assert.deepEqual(dashboardSettings(undefined), {});
  assert.deepEqual(dashboardSettings({ web: { port: 8000, enabled: false, relay: {} } }), { port: 8000, enabled: false });
  assert.deepEqual(dashboardSettings({ web: { port: 8000, enabled: false }, dashboard: { port: 9000 } }), { port: 9000, enabled: false });
  assert.deepEqual(dashboardSettings({ web: { enabled: true }, dashboard: { enabled: false } }), { enabled: false });
});

test('migrateDashboardSettings moves web.* once, keeps web.relay and never overrides dashboard.*', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-dashboard-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'settings.json');
  assert.deepEqual(await migrateDashboardSettings(home), { moved: [], conflicts: [] }, 'no settings file: nothing');
  await writeFile(file, JSON.stringify({ language: 'English', web: { port: 8100, enabled: false, permissions: ['files.read'], relay: { enabled: false } } }));
  assert.deepEqual(await migrateDashboardSettings(home), { moved: ['enabled', 'port', 'permissions'], conflicts: [] });
  const moved = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(moved), { language: 'English', web: { relay: { enabled: false } }, dashboard: { port: 8100, enabled: false, permissions: ['files.read'] } });
  assert.deepEqual(await migrateDashboardSettings(home), { moved: [], conflicts: [] }, 'a second run moves nothing');
  assert.equal(await readFile(file, 'utf8'), moved, 'and does not write');

  await writeFile(file, JSON.stringify({ web: { port: 8100, enabled: false }, dashboard: { port: 8200 } }));
  assert.deepEqual(await migrateDashboardSettings(home), { moved: ['enabled'], conflicts: ['port'] });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { web: { port: 8100 }, dashboard: { port: 8200, enabled: false } });

  // Only web.port, nothing else under web: the web key goes away.
  await writeFile(file, JSON.stringify({ web: { port: 8300 } }));
  await migrateDashboardSettings(home);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { dashboard: { port: 8300 } });
});
