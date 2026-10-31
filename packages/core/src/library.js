import { shippedTemplateRoot } from './template-path.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { moveFile } from './atomic.js';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AlpError } from './errors.js';

/**
 * The user's library: skills, role assignments and default providers, kept in
 * ALP_HOME and shared by every project. ALP seeds it from its templates once,
 * then updates only files the user has not changed; a file the user edited or
 * deleted stays that way across app updates.
 */

/** ALP_HOME, the user's ALP directory: alpd's home and the skill library. */
export function alpHome(env = process.env) {
  return path.resolve(env.ALP_HOME || path.join(os.homedir(), '.alp'));
}

const MANIFEST = 'library.json';
const sha = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

async function optional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Shipped library files: role skills, skill resources and default providers. */
async function shippedFiles({ templateRoot, templates }) {
  if (templates) return Object.fromEntries(Object.entries(templates).filter(([name]) => name === 'role-skills.json' || name.startsWith('skills/') || name.startsWith('providers/')));
  const root = templateRoot ?? shippedTemplateRoot();
  const files = { 'role-skills.json': await readFile(new URL('role-skills.json', root), 'utf8') };
  async function walk(relative) {
    for (const entry of await readdir(new URL(`${relative}/`, root), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${relative}/${entry.name}`);
      else if (entry.isFile()) files[`${relative}/${entry.name}`] = await readFile(new URL(`${relative}/${entry.name}`, root), 'utf8');
    }
  }
  await walk('skills');
  await walk('providers');
  return files;
}

/**
 * Every role-skills.json ALP shipped, by sha (CRLF-normalized), with what it gave each role. A
 * library's manifest names the one ALP last wrote, so the built-in skills its user has already been
 * offered are known for a library from before `roleSkillsOffered` was recorded (t-de1a). Add each
 * new shipped version here (packages/core/tests/role-skills-offer.test.js checks the current one is).
 * @type {Readonly<Record<string, Record<string, string[]>>>}
 */
export const SHIPPED_ROLE_SKILLS = Object.freeze({
  // 0086846 (2026-10-07)
  '7132b9ef1f10db55caea23dbe705a0ab06c83c86f51f074e663d12043a79327a': { main: ['goal-griller', 'xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], lead: ['xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], peer: ['xia', 'bug-loop', 'smart-commits'] },
  // 9ccd54c (2026-10-08): oracle and reviewer, with none
  'c03f7bcecd61e26e70ef05b268aa7881a75f9e9c45ae5486ae9659cefd6bb449': { main: ['goal-griller', 'xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], lead: ['xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], peer: ['xia', 'bug-loop', 'smart-commits'] },
  // 61181b5 (2026-10-09): supervisor, with none
  '8c5664042d4a4ecd3ded61240d8febbffa6e8965a88af0e9ba0420ad2f2ce8fe': { main: ['goal-griller', 'xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], lead: ['xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], peer: ['xia', 'bug-loop', 'smart-commits'] },
  // 9180aa1 (2026-10-29): compact for main
  'b12b52102c358119cf834e5f3be54e6a69aa4c9f388fe889dffbb529755292dc': { main: ['goal-griller', 'xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits', 'compact'], lead: ['xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], peer: ['xia', 'bug-loop', 'smart-commits'] },
  // f4d7986 (2026-10-29): curate for main
  'a84b035d0058cbfcda7e32dc1706b9e83e67764eed24e2e121bdfcd60f924e46': { main: ['goal-griller', 'xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits', 'compact', 'curate'], lead: ['xia', 'sequence-execution-plan', 'prompt-leverage', 'bug-loop', 'smart-commits'], peer: ['xia', 'bug-loop', 'smart-commits'] },
});

/** A role → skills object's pairs as `role/skill` strings; anything else gives none. @param {unknown} roles */
const rolePairs = roles => roles && typeof roles === 'object' && !Array.isArray(roles)
  ? Object.entries(roles).flatMap(([role, names]) => Array.isArray(names) ? names.filter(skillName).map(name => `${role}/${name}`) : [])
  : [];

/**
 * Offers the built-in role skills an edited role-skills.json has never been offered (t-de1a): each
 * goes to the end of its role's list, when that role is listed and lacks it. What was offered is
 * recorded in the manifest (`roleSkillsOffered`), so a skill the user then removes stays removed, and
 * nothing the user wrote is removed or reordered. A role the user's file does not list (setGivenSkills
 * drops a role given none) gets nothing; a file that is missing or not a JSON object is left alone, and
 * its skills are offered again once it can be read. Before the record exists, what the user was offered
 * is what the role-skills.json ALP last wrote gave (SHIPPED_ROLE_SKILLS); an unknown one offers nothing.
 * @returns {Promise<string[]>} the `role/skill` pairs added
 */
async function offerRoleSkills(home, manifest, shippedText, seeded) {
  const name = 'role-skills.json';
  const shipped = rolePairs(JSON.parse(shippedText));
  const baseline = Array.isArray(manifest.roleSkillsOffered) ? manifest.roleSkillsOffered
    : seeded !== undefined && Object.hasOwn(SHIPPED_ROLE_SKILLS, seeded) ? rolePairs(SHIPPED_ROLE_SKILLS[seeded])
      : shipped;
  const offered = new Set(baseline.filter(pair => typeof pair === 'string'));
  const fresh = shipped.filter(pair => !offered.has(pair));
  const record = () => { manifest.roleSkillsOffered = [...new Set([...offered, ...shipped])].sort(); };
  if (!fresh.length) { const before = JSON.stringify(manifest.roleSkillsOffered); record(); return { added: [], changed: before !== JSON.stringify(manifest.roleSkillsOffered) }; }
  const target = path.join(home, name);
  const text = await optional(target);
  if (text === undefined) { record(); return { added: [], changed: true }; }
  let roles;
  try { roles = JSON.parse(text); } catch { return { added: [], changed: false }; }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return { added: [], changed: false };
  const added = [];
  for (const pair of fresh) {
    const [role, skill] = pair.split('/');
    if (!Array.isArray(roles[role]) || roles[role].includes(skill)) continue;
    roles[role].push(skill);
    added.push(pair);
  }
  if (added.length) {
    const next = JSON.stringify(roles, null, 2) + '\n';
    const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, next);
    await moveFile(temporary, target);
  }
  record();
  return { added, changed: true };
}

/**
 * Seeds or updates the library in `home`. A file is written when ALP never
 * shipped it before, and replaced only while it still holds what ALP last wrote.
 * With `offerRoleSkills` (alp upgrade, alp update-template), an edited role-skills.json
 * is also offered the built-in role skills it never was (offerRoleSkills above).
 * @param {string} home
 * @param {{ templateRoot?: URL, templates?: Record<string, string>, offerRoleSkills?: boolean }} [options]
 * @returns {Promise<{ created: string[], updated: string[], offered?: string[] }>} offered only with offerRoleSkills
 */
export async function seedLibrary(home, options = {}) {
  const shipped = await shippedFiles(options);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(home, MANIFEST);
  const manifestText = await optional(manifestPath);
  const manifest = manifestText ? JSON.parse(manifestText) : { files: {} };
  const created = [];
  const updated = [];
  // What ALP last wrote of role-skills.json, before this run's update of it (offerRoleSkills).
  const seededRoles = manifest.files['role-skills.json'];
  for (const [name, content] of Object.entries(shipped).sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(home, ...name.split('/'));
    const current = await optional(target);
    const seeded = manifest.files[name];
    if (seeded === undefined) {
      // A file the user made under a shipped name stays theirs.
      if (current !== undefined) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      manifest.files[name] = sha(content);
      created.push(name);
    } else if (current !== undefined && sha(current) === seeded && seeded !== sha(content)) {
      await writeFile(target, content);
      manifest.files[name] = sha(content);
      updated.push(name);
    }
    // Missing after seeding: the user deleted it. Changed: the user edited it. Both are kept.
  }
  const offer = options.offerRoleSkills && shipped['role-skills.json'] !== undefined
    ? await offerRoleSkills(home, manifest, shipped['role-skills.json'], seededRoles)
    : undefined;
  if (created.length || updated.length || offer?.changed || manifestText === undefined) {
    await mkdir(home, { recursive: true });
    const temporary = `${manifestPath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
    await moveFile(temporary, manifestPath);
  }
  return { created, updated, ...(options.offerRoleSkills ? { offered: offer?.added ?? [] } : {}) };
}

const seeding = new Map();

/** Seeds a library once per process; sessions call it on every open. */
export function ensureLibrary(home, options = {}) {
  let done = seeding.get(home);
  if (!done) {
    done = seedLibrary(home, options).catch(error => { seeding.delete(home); throw error; });
    seeding.set(home, done);
  }
  return done;
}

const skillName = name => typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';

/** The library skills assigned to an agent, as named absolute SKILL.md paths that exist. */
export async function librarySkills(home, agent) {
  const file = path.join(home, 'role-skills.json');
  const text = await optional(file);
  if (text === undefined) return [];
  let roles;
  try { roles = JSON.parse(text); }
  catch (cause) { throw new AlpError('INVALID_LIBRARY', `${file}: ${cause.message}`, { cause }); }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new AlpError('INVALID_LIBRARY', `${file}: expected an object of role names to skill lists`);
  const names = roles[agent] ?? [];
  if (!Array.isArray(names) || !names.every(skillName)) throw new AlpError('INVALID_LIBRARY', `${file}: ${agent} must list skill directory names`);
  const skills = [];
  for (const name of new Set(names)) {
    const skillPath = path.join(home, 'skills', name, 'SKILL.md');
    if (await optional(skillPath) !== undefined) skills.push({ name, path: skillPath });
  }
  return skills;
}
