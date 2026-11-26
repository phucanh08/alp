// @ts-check
// The pnpm workspace list and lockfile, read in one place (they were package.json "workspaces" and
// package-lock.json under npm). Scripts that take a root (a copy, a fixture) pass it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The workspace locations, in pnpm-workspace.yaml's order (the order npm's "workspaces" had).
 * @param {string} [root]
 * @returns {string[]}
 */
export function workspaceLocations(root = ROOT) {
  const { packages } = parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
  if (!Array.isArray(packages) || !packages.every(location => typeof location === 'string')) throw new Error(`${path.join(root, 'pnpm-workspace.yaml')} has no packages list`);
  return packages;
}

/**
 * pnpm-lock.yaml, parsed.
 * @param {string} [root]
 * @returns {PnpmLock}
 */
export function readPnpmLock(root = ROOT) {
  return parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
}

/**
 * @typedef {{ specifier: string, version: string }} LockedDependency
 * @typedef {Partial<Record<'dependencies' | 'devDependencies' | 'optionalDependencies', Record<string, LockedDependency>>>} LockedImporter
 * @typedef {{ lockfileVersion?: string, importers?: Record<string, LockedImporter>, packages?: Record<string, unknown> }} PnpmLock
 */
