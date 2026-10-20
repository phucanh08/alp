// Run the real acceptance orchestration, replacing only tarball installation and acceptance
// steps with a local fixture. Its detached processes and delayed shutdown are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const scenario of ['pass', 'setup-failure', 'web-startup-failure', 'step-failure', 'package-startup-failure']) {
  test(`fake web acceptance cleans owned processes on ${scenario}`, async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'alp-web-cleanup-'));
    const journal = path.join(base, 'pids.jsonl');
    const env = { ...process.env, FIXTURE_BASE: base, FIXTURE_SCENARIO: scenario,
      HOME: path.join(base, 'os-home'), ALP_HOME: path.join(base, 'outer-alp'), PASEO_HOME: path.join(base, 'paseo'),
      XDG_CACHE_HOME: path.join(base, 'cache'), npm_config_cache: path.join(base, 'npm-cache'), npm_config_prefix: path.join(base, 'prefix') };
    await mkdir(env.HOME);
    await copyFile(path.join(root, 'scripts/beta-acceptance-web.mjs'), path.join(base, 'beta-acceptance-web.mjs'));
    await copyFile(path.join(root, 'scripts/beta-web-lifecycle.mjs'), path.join(base, 'beta-web-lifecycle.mjs'));
    await writeFile(path.join(base, 'worker.mjs'), `
      import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
      const [role, home] = process.argv.slice(2);
      const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
        const info = { pid: process.pid, port: server.address().port };
        fs.mkdirSync(path.join(home, 'integrations'), { recursive: true });
        fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ ...info, role, home }) + '\\n');
        fs.writeFileSync(path.join(home, role === 'web' ? 'integrations/web.lock' : 'alpd.lock'), JSON.stringify(info));
        if (role === 'web' && process.env.FIXTURE_SCENARIO !== 'web-startup-failure') fs.writeFileSync(path.join(home, 'web.json'), JSON.stringify(info));
      });
      process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), 150));
    `);
    await writeFile(path.join(base, 'launch.mjs'), `
      import { spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
      const [role, home] = process.argv.slice(2);
      const child = spawn(process.execPath, [${JSON.stringify(path.join(base, 'worker.mjs'))}, role, home], { env: process.env, detached: true, stdio: 'ignore' }); child.unref();
      const lock = path.join(home, role === 'web' ? 'integrations/web.lock' : 'alpd.lock');
      for (let i = 0; !fs.existsSync(lock); i++) { if (i > 500) process.exit(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
    `);
    await writeFile(path.join(base, 'beta-acceptance-lib.mjs'), `
      import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
      const base = process.env.FIXTURE_BASE; const scenario = process.env.FIXTURE_SCENARIO;
      export const CHOICES = {}; export const gateRow = () => 'R5'; export const manual = () => {};
      export const options = () => ({ work: base, fake: true });
      export const install = () => ({ consumer: base }); export const alpCommand = () => 'fixture-cli';
      export const environment = ({ home }) => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); return { ...process.env, ALP_HOME: home }; };
      export class Run {
        steps = []; logs = base;
        record(id, status, detail) { this.steps.push({ id, status, detail }); }
        summary() { fs.writeFileSync(path.join(base, 'results.json'), JSON.stringify(this.steps)); return this.steps.some(s => s.status === 'fail') ? 1 : 0; }
        exec(label, command, args, { env } = {}) {
          const launch = role => {
            const r = spawnSync(process.execPath, [path.join(base, 'launch.mjs'), role, env.ALP_HOME], { env });
            if (r.status !== 0) throw new Error('fixture launch failed');
          };
          if (label === 'setup' && args[1] === 'init') launch('daemon');
          if (label === 'setup' && args[1] === 'setup' && scenario === 'setup-failure') return { status: 1 };
          if (label === 'fixture-web') launch('web');
          if (label === 'cleanup') {
            const f = path.join(env.ALP_HOME, 'integrations/web.lock');
            if (fs.existsSync(f)) { const { pid } = JSON.parse(fs.readFileSync(f)); try { process.kill(pid, 0); fs.writeFileSync(path.join(base, 'wrong-order'), 'web still alive'); } catch {} }
            // A failed daemon stop must still trigger the owned-lock fallback.
            return { status: 1 };
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        async step(id, title, body) {
          const homes = fs.readdirSync(base).filter(n => n.startsWith('web-codex-fake-'));
          const home = path.join(base, homes[0], 'home');
          this.exec('fixture-web', '', [], { env: { ...process.env, ALP_HOME: home } });
          this.record(id, scenario === 'pass' ? 'pass' : 'fail', scenario);
        }
      }
    `);
    let entry = path.join(base, 'beta-acceptance-web.mjs');
    if (scenario === 'package-startup-failure') {
      const scripts = path.join(base, 'scripts');
      await mkdir(scripts);
      let source = await readFile(path.join(root, 'scripts/package-smoke.mjs'), 'utf8');
      source = source.replace("from 'node:child_process'", "from './fixture-child-process.mjs'");
      entry = path.join(scripts, 'package-smoke.mjs');
      await writeFile(entry, source);
      await copyFile(path.join(root, 'scripts/beta-web-lifecycle.mjs'), path.join(scripts, 'beta-web-lifecycle.mjs'));
      await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: '@anhlp/alp', workspaces: [] }));
      await writeFile(path.join(scripts, 'release-lib.mjs'), `export const releaseArtifacts = () => [
        { name: '@anhlp/alp', file: 'unused.tgz', files: new Map(['packages/cli/dist/cli.js', 'packages/core/dist/index.js', 'packages/client/dist/index.js', 'dist/alpd.js'].map(p => [p, ''])) },
        { name: '@anhlp/alp-paseo', file: 'unused-plugin.tgz', manifest: { peerDependencies: {} } }
      ];`);
      await writeFile(path.join(scripts, 'spawn-command.mjs'), `export const spawnCommand = (command, args) => [command, args];`);
      await writeFile(path.join(scripts, 'fixture-child-process.mjs'), `
        import { spawnSync as realSpawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
        export function spawnSync(command, args, options) {
          if (args[1] === 'web' && args[2] === '--print') {
            for (const role of ['daemon', 'web']) {
              const result = realSpawnSync(process.execPath, [path.join(process.env.FIXTURE_BASE, 'launch.mjs'), role, options.env.ALP_HOME], { env: options.env });
              if (result.status !== 0) throw new Error('fixture launch failed');
            }
            fs.writeFileSync(path.join(process.env.FIXTURE_BASE, 'package-home'), options.env.ALP_HOME);
            fs.copyFileSync(path.join(options.env.ALP_HOME, 'settings.json'), path.join(process.env.FIXTURE_BASE, 'package-settings.json')); 
            return { status: 1, stdout: '', stderr: 'injected failure after web lock publication' };
          }
          if (args[1] === 'daemon' && args[2] === 'stop') {
            const lock = path.join(options.env.ALP_HOME, 'integrations/web.lock');
            if (fs.existsSync(lock)) { try { process.kill(JSON.parse(fs.readFileSync(lock)).pid, 0); fs.writeFileSync(path.join(process.env.FIXTURE_BASE, 'wrong-order'), 'web still alive'); } catch {} }
          }
          return { status: 0, stdout: '', stderr: '' };
        }
      `);
    }
    let pids = [];
    try {
      const result = await exec(process.execPath, [entry, ...(scenario === 'package-startup-failure' ? ['--packs', base] : [])], { env, timeout: 20_000 }).catch(error => error);
      pids = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(result.code ?? 0, scenario === 'pass' ? 0 : 1, result.stderr);
      assert.equal(pids.length, scenario === 'setup-failure' ? 1 : 2);
      for (const entry of pids) assert.equal(alive(entry.pid), false, `${entry.role} ${entry.pid} leaked on ${scenario}`);
      console.log(JSON.stringify({ scenario, ownedProcesses: pids.map(entry => ({ ...entry, alive: alive(entry.pid) })) }));
      assert.equal(await readFile(path.join(base, 'wrong-order'), 'utf8').catch(() => undefined), undefined, 'web must exit before daemon stop');
      const settings = JSON.parse(await readFile(scenario === 'package-startup-failure' ? path.join(base, 'package-settings.json') : path.join(pids[0].home, 'settings.json'), 'utf8'));
      assert.equal(settings.web.port, 0);
      assert.equal(settings.web.relay.enabled, false);
    } finally {
      // Test failure must not reproduce the leak in the test runner itself.
      if (!pids.length) pids = (await readFile(journal, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
      for (const { pid } of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      for (let i = 0; i < 200 && pids.some(({ pid }) => alive(pid)); i++) await new Promise(resolve => setTimeout(resolve, 10));
      if (scenario === 'package-startup-failure') {
        const packageHome = await readFile(path.join(base, 'package-home'), 'utf8').catch(() => undefined);
        if (packageHome) await rm(path.dirname(packageHome), { recursive: true, force: true });
      }
      await rm(base, { recursive: true, force: true });
    }
  });
}
