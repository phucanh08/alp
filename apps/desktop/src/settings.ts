/** The app's settings file (<userData>/settings.json): `{ "alpPath": "/absolute/path/to/alp" }`. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type Settings = { alpPath?: string };

export async function readSettings(userData: string): Promise<Settings> {
  try {
    const value = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'));
    return value && typeof value === 'object' && typeof value.alpPath === 'string' ? { alpPath: value.alpPath } : {};
  } catch { return {}; }
}
