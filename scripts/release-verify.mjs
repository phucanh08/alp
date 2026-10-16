#!/usr/bin/env node
// A5 (docs/alp/beta-scope.md §6.1) on a saved release directory: reads only the files in it.
//
//   release-verify.mjs <directory> [--sha <RELEASE_SHA>] [--version <semver>] [--rehearsal] [--record <evidence.json>]
//
// --record writes the A5 row of a gate evidence file (see release-gate.mjs), only for a real pass.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateTemplate, verifyRelease } from './release-lib.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; const [, value] = args.splice(index, 2); if (!value) throw new Error(`${name} needs a value`); return value; };
const rehearsalAt = args.indexOf('--rehearsal');
const rehearsal = rehearsalAt >= 0;
if (rehearsal) args.splice(rehearsalAt, 1);
const sha = option('--sha');
const version = option('--version');
const record = option('--record');
if (args.length !== 1) throw new Error('Usage: release-verify.mjs <directory> [--sha <RELEASE_SHA>] [--version <semver>] [--rehearsal] [--record <evidence.json>]');
const directory = path.resolve(args[0]);

const { manifest, artifacts, problems, notes } = verifyRelease(directory, { sha, version, rehearsal });
for (const artifact of artifacts) console.log(`${artifact.sha256}  ${artifact.filename}  ${artifact.name}@${artifact.version}  ${artifact.files.size} files`);
for (const note of notes) console.log(`rehearsal only: ${note}`);
if (problems.length) {
  console.error(`A5 FAILED for ${directory}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`A5 passed: ${artifacts.length} tarballs of ${manifest.version} from ${manifest.git?.sha ?? 'no commit'} match ${path.basename(directory)}/SHA256SUMS (${manifest.sha256sums}).`);
if (rehearsal) console.log('REHEARSAL: not gate evidence.');

if (record) {
  if (rehearsal || !sha) throw new Error('--record needs --sha <RELEASE_SHA> and a non-rehearsal run');
  const evidence = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : gateTemplate(manifest);
  evidence.rows.A5 = { status: 'pass', sha, artifacts: manifest.sha256sums, environment: `${os.type()} ${os.release()}, Node ${process.version}`, runner: os.userInfo().username, evidence: `release-verify ${directory}`, date: new Date().toISOString() };
  writeFileSync(record, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Recorded A5 in ${record}.`);
}
