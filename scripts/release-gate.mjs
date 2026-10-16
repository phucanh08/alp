#!/usr/bin/env node
// The release gate (docs/alp/beta-scope.md §6.1, §6.4, §7.5) as data: which rows block, and whether
// the recorded evidence passes them for this release's SHA and saved artifacts. It only reads and
// reports; people and CI record the rows, and the gate never passes on local checks alone.
//
//   release-gate.mjs <release directory> --init <evidence.json>        write every row as pending
//   release-gate.mjs <release directory> <evidence.json> [--phase publish|latest|announce]
//
// Phases: publish = the pre-publish gate (P4); latest = that plus Q1–Q3, required before Q4 moves
// `latest` (D2); announce = everything through Q5, before the GitHub release leaves draft.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GATE_PHASES, MANIFEST_FILE, evaluateGate, gateTemplate } from './release-lib.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: release-gate.mjs <release directory> (--init <evidence.json> | <evidence.json> [--phase publish|latest|announce])';
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; const [, value] = args.splice(index, 2); if (!value) throw new Error(usage); return value; };
const init = option('--init');
const phase = option('--phase') ?? 'publish';
if (!GATE_PHASES[phase] || args.length !== (init ? 1 : 2)) throw new Error(usage);
const manifest = JSON.parse(readFileSync(path.join(path.resolve(args[0]), MANIFEST_FILE), 'utf8'));

if (init) {
  if (existsSync(init)) throw new Error(`${init} exists; the gate template never overwrites recorded evidence`);
  writeFileSync(init, `${JSON.stringify(gateTemplate(manifest), null, 2)}\n`);
  console.log(`Wrote ${init}: every row pending for ${manifest.version} at ${manifest.git?.sha}, artifacts ${manifest.sha256sums}.`);
  process.exit(0);
}

const evidence = JSON.parse(readFileSync(args[1], 'utf8'));
const result = evaluateGate(evidence, manifest, phase);
console.log(`Gate "${phase}" for ${manifest.version} at ${manifest.git?.sha ?? '(no SHA)'}; artifacts ${manifest.sha256sums}`);
for (const row of result.rows) {
  const mark = row.ok ? 'PASS' : row.blocking ? 'OPEN' : 'info';
  console.log(`${mark.padEnd(4)}  ${row.id.padEnd(3)} ${row.blocking ? '' : '(not blocking) '}${row.title}${row.ok ? '' : ` — ${row.reasons.join('; ')}`}`);
}
for (const other of result.blocking.filter(row => row.id === 'evidence')) console.log(`OPEN  ${other.reasons.join('; ')}`);
console.log(result.passed ? `Gate "${phase}" passed.` : `Gate "${phase}" NOT passed: ${result.blocking.length} blocking row(s) open.`);
process.exitCode = result.passed ? 0 : 1;
