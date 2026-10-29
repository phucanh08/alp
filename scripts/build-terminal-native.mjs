// Developer/release build only. Never called by terminal startup or postinstall.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slots = ['darwin-arm64', 'darwin-x64', 'linux-x64-glibc', 'linux-arm64-glibc', 'linux-x64-musl', 'linux-arm64-musl'];
const libc = process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : undefined;
const targetArch = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7) ?? process.arch;
if (targetArch !== process.arch && !(process.platform === 'darwin' && ['arm64', 'x64'].includes(targetArch))) throw new Error('Cross architecture requires an existing Darwin toolchain');
const slot = [process.platform, targetArch, libc].filter(Boolean).join('-');
if (!slots.includes(slot)) throw new Error(`Unsupported build host ${slot}`);
const source = path.join(root, 'packages/daemon/native/terminal-owner.c');
const dir = path.join(root, 'packages/daemon/native/prebuilt', slot);
mkdirSync(dir, { recursive: true });
const binary = path.join(dir, 'terminal-owner');
const args = [...(process.platform === 'darwin' ? ['-mmacosx-version-min=11.0', '-arch', targetArch === 'x64' ? 'x86_64' : 'arm64'] : []), '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', binary, ...(process.platform === 'linux' ? ['-lutil'] : [])];
const result = spawnSync(process.env.CC || 'cc', args, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
if (process.platform === 'darwin') {
  const signed = spawnSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
  if (signed.status !== 0) throw new Error('Native ad-hoc signing failed');
}
const smoke = spawnSync(binary, ['--capability'], { encoding: 'utf8' });
if (smoke.status !== 0 || smoke.stdout.trim() !== 'alp-terminal-owner:1') throw new Error('Native capability smoke failed');
const sha256 = value => createHash('sha256').update(value).digest('hex');
writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ protocol: 1, slot, source: sha256(readFileSync(source)), sha256: sha256(readFileSync(binary)), buildHost: process.version, ...(process.platform === 'darwin' ? { deploymentTarget: '11.0' } : {}), executionChecked: true, executionHost: `${process.platform}-${process.arch}` }, null, 2) + '\n');
console.log(`Built and executed ${slot}. Other matrix slots were NOT built or checked.`);
if (process.argv.includes('--require-matrix')) {
  for (const target of slots) {
    const entry = path.join(root, 'packages/daemon/native/prebuilt', target);
    let manifest;
    try { manifest = JSON.parse(readFileSync(path.join(entry, 'manifest.json'), 'utf8')); } catch { throw new Error(`Missing required prebuilt ${target}`); }
    if (manifest.source !== sha256(readFileSync(source)) || manifest.sha256 !== sha256(readFileSync(path.join(entry, 'terminal-owner'))) || manifest.slot !== target || manifest.protocol !== 1) throw new Error(`Stale/invalid prebuilt ${target}`);
  }
}
