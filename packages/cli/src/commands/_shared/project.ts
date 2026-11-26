import { access } from 'node:fs/promises';
import path from 'node:path';

/** The ALP project a task command works on: --project, or the current directory. */
export async function taskProject(directory?: string): Promise<string> {
  const root = path.resolve(directory ?? process.cwd());
  try { await access(path.join(root, '.alp')); }
  catch { throw new Error(`${root} is not an ALP project (no .alp directory); run alp init, or pass --project`); }
  return root;
}

/** `--project` may stand alone, meaning the current directory. */

export function projectFlag(args: string[]): string[] {
  const result = [...args];
  for (let i = 0; i < result.length; i++) if (result[i] === '--project' && (i + 1 === result.length || result[i + 1].startsWith('-'))) result.splice(i + 1, 0, '.');
  return result;
}
