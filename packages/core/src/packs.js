import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { moveFile } from './atomic.js';
import { AlpError } from './errors.js';
import { seedLibrary } from './library.js';
import { BASES, validatePermissions } from './permissions.js';
import { validateSkill } from './skill-validate.js';
import { shippedTemplateRoot } from './template-path.js';
import { validateTeam } from './teams.js';
import { validateAgentConfig } from './validation.js';

/**
 * Optional packs (skill system v2): groups of specialist skills, custom agents and teams that ship
 * in ALP's templates under packs/<id>/ but are never seeded. A user opts in with `alp pack install`,
 * which copies the entries into the library or a project's .alp/ like any entry the user made
 * there: an entry that already exists is kept, whatever it holds, so an update or a reinstall never
 * overwrites the user's version. Nothing is assigned to a role unless asked (`assign`), nothing is
 * installed or run besides copying files, and no dependency is fetched.
 *
 *   packs/<id>/pack.json   { label, description, skills?, agents?, teams?, assign?, permissions? }
 *   packs/<id>/skills/<name>/...   packs/<id>/agents/<name>/...   packs/<id>/teams/<name>/...
 */

const KINDS = ['skills', 'agents', 'teams'];
const PACK_KEYS = ['label', 'description', ...KINDS, 'assign', 'permissions'];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = (code, message) => { throw new AlpError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every shipped pack file, as packs/<id>/<path> -> text: from a bundle's templates or the package. */
async function shippedPackFiles({ templates } = {}) {
  if (templates) return Object.fromEntries(Object.entries(templates).filter(([name]) => name.startsWith('packs/')));
  const root = new URL('packs/', shippedTemplateRoot());
  const files = {};
  const walk = async relative => {
    let entries;
    try { entries = await readdir(new URL(relative, root), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(`${relative}${entry.name}/`);
      else if (entry.isFile()) files[`packs/${relative}${entry.name}`] = await readFile(new URL(`${relative}${entry.name}`, root), 'utf8');
    }
  };
  await walk('');
  return files;
}

/** Checks a pack.json against the files the pack holds. */
export function validatePack(id, manifest, files) {
  const where = `packs/${id}/pack.json`;
  const bad = message => fail('INVALID_PACK', `${where}: ${message}`);
  if (!object(manifest)) bad('expected a JSON object');
  for (const key of Object.keys(manifest)) if (!PACK_KEYS.includes(key)) bad(`unknown key '${key}'; expected ${PACK_KEYS.join(', ')}`);
  for (const key of ['label', 'description']) if (typeof manifest[key] !== 'string' || !manifest[key].trim()) bad(`${key} must be nonempty text`);
  for (const kind of KINDS) {
    const names = manifest[kind] ?? [];
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && NAME.test(name))) bad(`${kind} must list entry names`);
    const main = { skills: 'SKILL.md', agents: 'AGENT.md', teams: 'team.json' }[kind];
    for (const name of names) if (files[`packs/${id}/${kind}/${name}/${main}`] === undefined) bad(`${kind} names '${name}', which has no ${kind}/${name}/${main}`);
  }
  if (!(manifest.skills?.length || manifest.agents?.length || manifest.teams?.length)) bad('a pack holds at least one skill, agent or team');
  if (manifest.assign !== undefined) {
    if (!object(manifest.assign)) bad('assign must map roles to skills');
    for (const [role, skills] of Object.entries(manifest.assign)) {
      if (!Array.isArray(skills) || !skills.every(skill => (manifest.skills ?? []).includes(skill))) bad(`assign.${role} may name only this pack's skills`);
    }
  }
  if (manifest.permissions !== undefined) {
    if (!object(manifest.permissions)) bad('permissions must map agents to a base mode');
    for (const [agent, base] of Object.entries(manifest.permissions)) {
      if (!(manifest.agents ?? []).includes(agent)) bad(`permissions names '${agent}', which is not one of this pack's agents`);
      if (!BASES.includes(base)) bad(`permissions.${agent} must be one of ${BASES.join(', ')}`);
    }
  }
  return manifest;
}

/**
 * The packs ALP ships.
 * @returns {Promise<Array<{ id: string, label: string, description: string, skills: string[], agents: string[], teams: string[], assign: Record<string, string[]>, permissions: Record<string, string> }>>}
 */
export async function listPacks(options = {}) {
  const files = await shippedPackFiles(options);
  const ids = [...new Set(Object.keys(files).filter(name => /^packs\/[^/]+\/pack\.json$/.test(name)).map(name => name.split('/')[1]))].sort();
  return ids.map(id => {
    let manifest;
    try { manifest = JSON.parse(files[`packs/${id}/pack.json`]); }
    catch (cause) { throw new AlpError('INVALID_PACK', `packs/${id}/pack.json: ${cause.message}`, { cause }); }
    validatePack(id, manifest, files);
    return { id, label: manifest.label, description: manifest.description, skills: manifest.skills ?? [], agents: manifest.agents ?? [], teams: manifest.teams ?? [], assign: manifest.assign ?? {}, permissions: manifest.permissions ?? {} };
  });
}

const present = target => lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await moveFile(temporary, file);
}

/**
 * Installs a pack into the library (`scope: 'library'`) or a project's .alp/ (`scope: 'project'`).
 * Each entry is written to a temporary directory, checked (skills strictly, agent.json and team.json
 * by their schemas), then renamed into place; an entry of that name already there is kept as is.
 * `assign` (library only) adds the pack's suggested skills to roles in role-skills.json; the
 * permissions a pack's agents need (an advisor's read-only cap) are added to that scope's settings
 * only when the agent has no entry there, and a different entry is reported, never changed.
 * @param {string} id
 * @param {{ scope: 'library' | 'project', root?: string, library?: string, assign?: boolean, templates?: Record<string, string> }} options
 */
export async function installPack(id, { scope, root, library, assign = false, templates } = {}) {
  if (typeof id !== 'string' || !NAME.test(id)) fail('INVALID_NAME', `'${id}' is not a pack name`);
  const packs = await listPacks({ templates });
  const pack = packs.find(candidate => candidate.id === id) ?? fail('NOT_FOUND', `No pack '${id}'; packs are ${packs.map(candidate => candidate.id).join(', ')}`);
  if (scope !== 'library' && scope !== 'project') fail('INVALID_SCOPE', 'Scope must be library or project');
  if (scope === 'library' && !library) fail('INVALID_SCOPE', 'No library: ALP_HOME is not set');
  if (scope === 'project' && !root) fail('INVALID_SCOPE', 'No project directory');
  if (assign && scope !== 'library') fail('INVALID_SCOPE', 'Only the library assigns skills to roles (role-skills.json); in a project, name the skills in a project agent: alp agent edit <role> --project --skills a,b');
  // The core skills a pack's agents name live in the library.
  if (library) await seedLibrary(library, templates ? { templates } : {});
  const base = scope === 'library' ? library : path.join(path.resolve(root), '.alp');
  const files = await shippedPackFiles({ templates });
  const installed = [];
  const kept = [];
  for (const kind of KINDS) {
    for (const name of pack[kind]) {
      const target = path.join(base, kind, name);
      if (await present(target)) { kept.push({ kind, name, path: target }); continue; }
      const prefix = `packs/${id}/${kind}/${name}/`;
      // Staged outside the kind's directory, under the entry's own name, so no listing sees it half-written.
      const stagingRoot = path.join(base, `.alp-pack-${randomUUID().slice(0, 8)}.tmp`);
      const staging = path.join(stagingRoot, name);
      try {
        for (const [file, content] of Object.entries(files).filter(([file]) => file.startsWith(prefix))) {
          const relative = file.slice(prefix.length);
          const destination = path.join(staging, ...relative.split('/'));
          await mkdir(path.dirname(destination), { recursive: true, ...(scope === 'library' ? { mode: 0o700 } : {}) });
          await writeFile(destination, content);
          // Bundles carry templates as text; a script's executable bit follows its #! line.
          if (process.platform !== 'win32' && relative.startsWith('scripts/') && content.startsWith('#!')) await chmod(destination, 0o755);
        }
        if (kind === 'skills') {
          const { errors } = await validateSkill(staging, { mode: 'strict' });
          if (errors.length) fail('INVALID_PACK', `packs/${id}/skills/${name}: ${errors.map(finding => finding.message).join('; ')}`);
        }
        if (kind === 'agents') {
          const config = await readFile(path.join(staging, 'agent.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return {}; throw error; });
          validateAgentConfig(config, `${prefix}agent.json`);
        }
        if (kind === 'teams') validateTeam(JSON.parse(await readFile(path.join(staging, 'team.json'), 'utf8')), `${prefix}team.json`);
        // Made meanwhile by someone else: theirs is kept.
        if (await present(target)) { kept.push({ kind, name, path: target }); continue; }
        await mkdir(path.dirname(target), { recursive: true });
        await rename(staging, target);
        installed.push({ kind, name, path: target });
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
  }

  const permissions = { set: [], kept: [], conflicts: [] };
  if (Object.keys(pack.permissions).length) {
    const file = scope === 'library' ? path.join(library, 'settings.json') : path.join(base, 'settings.json');
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    let settings = {};
    if (text !== undefined) {
      try { settings = JSON.parse(text); } catch (cause) { throw new AlpError('INVALID_SETTINGS', `${file}: ${cause.message}`, { cause }); }
      if (!object(settings)) fail('INVALID_SETTINGS', `${file}: expected a JSON object`);
    }
    const current = object(settings.permissions) ? settings.permissions : {};
    const agents = object(current.agents) ? current.agents : {};
    let changed = false;
    for (const [agent, required] of Object.entries(pack.permissions)) {
      // An agent of that name that was already there is the user's: its permissions are theirs to set.
      if (!installed.some(entry => entry.kind === 'agents' && entry.name === agent)) { if (!Object.hasOwn(agents, agent) || agents[agent] !== required) permissions.conflicts.push(`${agent}: your own ${agent} agent was kept, so its permissions were left as they are; the pack's ${agent} expects '${required}'`); continue; }
      if (!Object.hasOwn(agents, agent)) { agents[agent] = required; permissions.set.push(`${agent}: ${required}`); changed = true; }
      else if (agents[agent] === required) permissions.kept.push(`${agent}: ${required}`);
      else permissions.conflicts.push(`${agent}: ${file} gives '${agents[agent]}', the pack expects '${required}'; left as it is`);
    }
    if (changed) {
      const next = { ...settings, permissions: { ...current, agents } };
      validatePermissions(next.permissions, file);
      await writeJsonAtomic(file, next);
    }
  }

  const assigned = [];
  if (assign && Object.keys(pack.assign).length) {
    const file = path.join(library, 'role-skills.json');
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; });
    let roles;
    try { roles = JSON.parse(text); } catch (cause) { throw new AlpError('INVALID_LIBRARY', `${file}: ${cause.message}; the pack was installed but no role was given its skills`, { cause }); }
    if (!object(roles)) fail('INVALID_LIBRARY', `${file}: expected an object of role names to skill lists`);
    for (const [role, skills] of Object.entries(pack.assign)) {
      const list = Array.isArray(roles[role]) ? roles[role] : (roles[role] = []);
      for (const skill of skills) if (!list.includes(skill)) { list.push(skill); assigned.push(`${role}/${skill}`); }
    }
    if (assigned.length) await writeJsonAtomic(file, roles);
  }
  return { pack: id, scope, installed, kept, assigned, permissions };
}

/** Which of a pack's entries a scope already has: for listings. */
export async function packStatus(pack, { root, library } = {}) {
  const has = async base => {
    if (!base) return false;
    for (const kind of KINDS) for (const name of pack[kind]) if (!(await present(path.join(base, kind, name)))) return false;
    return true;
  };
  return { library: await has(library), project: await has(root ? path.join(path.resolve(root), '.alp') : undefined) };
}
