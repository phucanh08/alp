// Copy shipped assets only; NEVER compile or install tools during build/startup.
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const nativeSlots = ['darwin-arm64', 'darwin-x64', 'linux-x64-glibc', 'linux-arm64-glibc', 'linux-x64-musl', 'linux-arm64-musl'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'packages/daemon/native');
const sha = value => createHash('sha256').update(value).digest('hex');
export async function verifyTerminalNative({ requireMatrix = false } = {}) {
  const source = sha(await readFile(path.join(native, 'terminal-owner.c')));
  const available = [], missing = [];
  for (const slot of nativeSlots) {
    const directory = path.join(native, 'prebuilt', slot);
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') { missing.push(slot); continue; } throw error; }
    if (manifest.protocol !== 1 || manifest.slot !== slot || manifest.source !== source || manifest.sha256 !== sha(await readFile(path.join(directory, 'terminal-owner')))) throw new Error(`Invalid/stale native helper ${slot}`);
    available.push(slot);
  }
  if (requireMatrix && missing.length) throw new Error(`Missing required native matrix: ${missing.join(', ')}`);
  return { available, missing };
}
export async function copyTerminalNative(destination) {
  const matrix = await verifyTerminalNative();
  // Replace the complete owned generated directory; stale binaries must never survive rebuild.
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  for (const file of ['terminal-owner.c', 'README.md']) await cp(path.join(native, file), path.join(destination, file));
  for (const slot of matrix.available) await cp(path.join(native, 'prebuilt', slot), path.join(destination, 'prebuilt', slot), { recursive: true });
  if (matrix.missing.length) console.warn(`Native terminals unavailable for missing slots: ${matrix.missing.join(', ')}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyTerminalNative({ requireMatrix: process.argv.includes('--require-matrix') });
  console.log(JSON.stringify(result));
}
