import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';

/** Preflight static repository paths. Does not isolate concurrent same-user processes. */
export async function assertNoSymlinks(directory, relative) {
  const root = path.resolve(directory);
  const target = path.resolve(root, relative);
  const tail = path.relative(root, target);
  if (tail === '..' || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
    throw new AlpError('UNSAFE_PATH', 'Path escapes its scope');
  }
  let current = root;
  for (const part of ['', ...tail.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new AlpError('UNSAFE_PATH', `Refusing symlink in scoped path: ${current}`);
  }
}
