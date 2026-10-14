#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const groups = {
  protocol: ['monorepo'],
  core: ['init', 'upgrade', 'resolver', 'ir', 'adapter', 'tasks', 'teams', 'permissions', 'profiles', 'library', 'library-edit', 'beads', 'verify', 'hooks', 'workflow', 'instructions', 'template-settings-sync'],
  runtime: ['runtime', 'transport', 'acp', 'antigravity', 'context', 'usage', 'pause', 'recovery', 'recall', 'delegation', 'supervisor', 'hardening', 'verdict', 'worktree', 'board', 'team', 'limit-watch', 'skill-use', 'skills', 'golden', 'monorepo'],
  client: ['service', 'supervise', 'doctor', 'setup', 'reachable', 'library-tools', 'prompt', 'language', 'daemon-paths'],
  daemon: ['daemon', 'daemon-git', 'web', 'relay', 'paseo-web', 'providers-web', 'human', 'epic'],
  cli: ['init', 'setup', 'doctor', 'tasks', 'language', 'permissions', 'library-edit', 'beads', 'verify', 'service', 'acp-agent'],
  paseo: ['paseo', 'panel', 'settings', 'settings-screen', 'providers-web', 'paseo-web', 'library-tools'],
};
const selected = process.argv[2] === 'paseo-plugin' ? 'paseo' : process.argv[2];
if (!groups[selected]) throw new Error(`Unknown workspace: ${selected}`);
const packagesBuilt = spawnSync(process.execPath, ['scripts/build-workspace.mjs', 'runtime'], { cwd: root, stdio: 'inherit' });
if (packagesBuilt.status !== 0) process.exit(packagesBuilt.status ?? 1);
const built = spawnSync(process.execPath, ['scripts/build-paseo.mjs'], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const cliBuilt = spawnSync(process.execPath, ['scripts/build-workspace.mjs', 'cli'], { cwd: root, stdio: 'inherit' });
if (cliBuilt.status !== 0) process.exit(cliBuilt.status ?? 1);
const home = mkdtempSync(path.join(os.tmpdir(), 'alp-workspace-test-'));
try {
  const result = spawnSync(process.execPath, ['--test', ...groups[selected].map(name => `test/${name}.test.js`)], { cwd: root, stdio: 'inherit', env: { ...process.env, ALP_HOME: home } });
  process.exitCode = result.status ?? 1;
} finally { rmSync(home, { recursive: true, force: true }); }
