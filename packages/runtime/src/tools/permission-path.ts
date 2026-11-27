import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Resolve each component before '..', matching filesystem traversal through links.
 * Missing leaves are allowed for creation; dangling links and other errors fail closed. */
function canonical(file: string): string {
  const absolute = path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`;
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(process.platform === 'win32' ? /[\\/]/ : /\//)) {
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const candidate = path.join(current, part);
    try { current = realpathSync.native(candidate); }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        if (lstatSync(candidate).isSymbolicLink()) throw new Error('Dangling symlink');
      } catch (infoError: any) { if (infoError?.code !== 'ENOENT') throw infoError; }
      current = candidate;
    }
  }
  return current;
}
const contains = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** ALP's permission gate, not an OS sandbox or protection against concurrent link swaps. */
export function writablePath(file: unknown, workdir: string): boolean {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) return false;
  try {
    const target = canonical(path.isAbsolute(file) ? file : `${workdir}${path.sep}${file}`);
    return contains(canonical(workdir), target) || contains(canonical(os.tmpdir()), target);
  } catch { return false; }
}
