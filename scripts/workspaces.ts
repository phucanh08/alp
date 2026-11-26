// The pnpm workspace list and lockfile, read in one place (they were package.json "workspaces" and
// package-lock.json under npm). Scripts that take a root (a copy, a fixture) pass it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The workspace locations, in pnpm-workspace.yaml's order (the order npm's "workspaces" had).
 */
export function workspaceLocations(root: string = ROOT): string[] {
  const { packages } = parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
  if (!Array.isArray(packages) || !packages.every(location => typeof location === 'string')) throw new Error(`${path.join(root, 'pnpm-workspace.yaml')} has no packages list`);
  return packages;
}

/**
 * pnpm-lock.yaml, parsed.
 */
export function readPnpmLock(root: string = ROOT): PnpmLock {
  return parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
}

export type LockedDependency = { specifier: string, version: string };
export type LockedImporter = Partial<Record<'dependencies' | 'devDependencies' | 'optionalDependencies', Record<string, LockedDependency>>>;
export type PnpmLock = { lockfileVersion?: string, importers?: Record<string, LockedImporter>, packages?: Record<string, unknown> };
