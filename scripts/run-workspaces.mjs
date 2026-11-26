#!/usr/bin/env node
// @ts-check
// `pnpm run <script>` in every workspace that has it, one at a time, in pnpm-workspace.yaml's order:
// the order `npm run <script> --workspaces --if-present` used. Not `pnpm -r`, which sorts by the
// dependency graph: the builds write shared dist/ trees (packages/protocol/dist is rebuilt by later
// workspaces' builds), so the order decides the published files.
//   node scripts/run-workspaces.mjs <script>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { exitDescription, spawnCommand } from './spawn-command.mjs';
import { workspaceLocations } from './workspaces.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const script = process.argv[2];
if (!script || process.argv.length > 3) throw new Error('Usage: run-workspaces.mjs <script>');
for (const location of workspaceLocations(ROOT)) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, location, 'package.json'), 'utf8'));
  if (!pkg.scripts?.[script]) continue;
  console.log(`\n[run-workspaces] ${pkg.name}: pnpm run ${script}`);
  const result = spawnSync(...spawnCommand('pnpm', ['run', script]), { cwd: path.join(ROOT, location), stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[run-workspaces] ${pkg.name}: pnpm run ${script} ${exitDescription(result)}`);
    process.exit(result.status || 1);
  }
}
