#!/usr/bin/env node
// Validates skills strictly, as ALP ships them: every skill in templates/skills and
// templates/packs/*/skills by default, or the skill directories named as arguments.
// Exit 1 when any skill has an error; warnings are printed but do not fail.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { formatValidation, validateSkill } from '../packages/core/src/skill-validate.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const dirs = async parent => (await readdir(parent, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => path.join(parent, e.name));

/** Every shipped skill directory: core skills and the skills of each optional pack. */
export async function shippedSkillDirs(root = ROOT) {
  const packs = await dirs(path.join(root, 'templates', 'packs'));
  return [...await dirs(path.join(root, 'templates', 'skills')), ...(await Promise.all(packs.map(pack => dirs(path.join(pack, 'skills'))))).flat()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = process.argv.slice(2).length ? process.argv.slice(2).map(dir => path.resolve(dir)) : await shippedSkillDirs();
  let failed = 0;
  for (const dir of targets) {
    const report = await validateSkill(dir, { mode: 'strict', shipped: true });
    if (!report.ok) failed++;
    console.log(formatValidation(report));
  }
  console.log(`${targets.length} skill(s), ${failed} with errors`);
  process.exitCode = failed ? 1 : 0;
}
