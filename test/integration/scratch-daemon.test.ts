// t-0336: the guard the live Paseo lanes (workflow, claude, mailbox) run before anything else. It is a
// safety boundary: a refusal is what keeps those lanes off the user's own Paseo daemon (port 6767) and
// their real ~/.alp. Pure apart from read-only realpath calls; nothing here connects or writes outside
// its own scratch directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scratchDaemon } from '../e2e/scratch-daemon.mjs';

const home = os.userInfo().homedir;
const realAlp = path.join(home, '.alp');
const refused = (env: Record<string, string>) => scratchDaemon(env) instanceof Error;
const scratchHome = path.join(os.tmpdir(), 'alp-scratch-daemon-test', '.alp');

test('scratchDaemon refuses the user daemon and the real ALP home; a declared scratch home passes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alp-scratch-daemon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'link-to-alp');
  await symlink(realAlp, link);

  const refusedCases: Record<string, Record<string, string>> = {
    'nothing declared': {},
    'port 6767 (the user Paseo daemon)': { ALP_TEST_PASEO_URL: 'ws://127.0.0.1:6767/ws', ALP_TEST_ALP_HOME: scratchHome },
    'port 6767 via localhost': { ALP_TEST_PASEO_URL: 'ws://localhost:6767/ws', ALP_TEST_ALP_HOME: scratchHome },
    'port 6767 via [::1]': { ALP_TEST_PASEO_URL: 'ws://[::1]:6767/ws', ALP_TEST_ALP_HOME: scratchHome },
    'a remote host': { ALP_TEST_PASEO_URL: 'ws://10.0.0.5:16767/ws', ALP_TEST_ALP_HOME: scratchHome },
    'a relative home': { ALP_TEST_ALP_HOME: 'scratch/.alp' },
    'the real ~/.alp': { ALP_TEST_ALP_HOME: realAlp },
    'a directory inside ~/.alp': { ALP_TEST_ALP_HOME: path.join(realAlp, 'sub') },
    'a "..foo" child of ~/.alp': { ALP_TEST_ALP_HOME: path.join(realAlp, '..foo') },
    'the home that contains ~/.alp': { ALP_TEST_ALP_HOME: home },
    'a run-log directory inside ~/.alp': { ALP_TEST_ALP_HOME: scratchHome, ALP_TEST_RUN_LOG_DIR: path.join(realAlp, 'runs') },
    'a relative run-log directory': { ALP_TEST_ALP_HOME: scratchHome, ALP_TEST_RUN_LOG_DIR: 'runs' },
    'the real ~/.paseo': { ALP_TEST_ALP_HOME: scratchHome, ALP_TEST_PASEO_HOME: path.join(home, '.paseo') },
  };
  // Case-insensitive file systems (macOS, Windows): another case of ~/.alp is the same directory. On
  // Linux it is a different one, and the guard rightly allows it.
  if (process.platform === 'darwin' || process.platform === 'win32') refusedCases['~/.alp in another case'] = { ALP_TEST_ALP_HOME: path.join(home, '.ALP') };
  // A symlink into ~/.alp resolves only where ~/.alp exists (realpath); a fresh machine or CI runner
  // has none, and then there is no real home behind the link to protect.
  if (existsSync(realAlp)) {
    refusedCases['a symlink to ~/.alp'] = { ALP_TEST_ALP_HOME: link };
    refusedCases['a missing child of a symlink to ~/.alp'] = { ALP_TEST_ALP_HOME: path.join(link, 'sub', 'deeper') };
  } else t.diagnostic(`${realAlp} does not exist here: the symlink cases are not checked`);
  for (const [name, env] of Object.entries(refusedCases)) assert.equal(refused(env), true, `refused: ${name}`);

  const accepted = scratchDaemon({ ALP_TEST_ALP_HOME: scratchHome });
  assert.deepEqual(accepted, { url: 'ws://127.0.0.1:16767/ws', alpHome: path.resolve(scratchHome), runLogDir: path.resolve(scratchHome, 'runs') });
  // Neighbours of ~/.alp that are not inside it stay allowed.
  assert.equal(refused({ ALP_TEST_ALP_HOME: path.join(home, '.alp-old') }), false, '~/.alp-old is a sibling');
  assert.equal(refused({ ALP_TEST_ALP_HOME: path.join(dir, '..foo') }), false, 'a "..foo" directory outside ~/.alp');
  assert.equal(refused({ ALP_TEST_ALP_HOME: scratchHome, ALP_TEST_PASEO_URL: 'ws://[::1]:16767/ws' }), false, 'a loopback scratch port');
  // The refusal says why and where to look.
  assert.match(scratchDaemon({}).message, /ALP_TEST_ALP_HOME is not set.*paseo-plugin\.md/s);
});
