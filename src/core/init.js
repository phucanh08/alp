import { mkdir, writeFile, lstat, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectProfiles, profileDefaults, syncTemplateProfiles } from './profiles.js';
import { validateSettings } from './validation.js';

/**
 * Fill missing scaffold files without replacing existing user content: ALP.md and
 * .alp/settings.json. Agents, skills, MCP servers and hooks come from ALP's built-ins
 * and the user's library (ALPD §41); a project adds its own under .alp/ only to
 * override them.
 * @param {string} projectRoot
 * @param {{ templateRoot?: URL, templates?: Record<string, string>, library?: string, syncProfiles?: boolean, onlyManagedProfiles?: boolean, teamIds?: string[] }} [options]
 */
export async function initProject(projectRoot, { templateRoot, templates, library, syncProfiles = true, onlyManagedProfiles = false, teamIds } = {}) {
  const root = path.resolve(projectRoot);
  const sourceRoot = () => templateRoot ?? new URL('../../templates/', import.meta.url);
  const template = name => templates ? Promise.resolve(templates[name]) : readFile(new URL(name, sourceRoot()), 'utf8');
  const scaffold = path.join(root, '.alp');
  const existing = await lstat(scaffold).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && !existing.isDirectory()) throw new Error(`Expected a directory: ${scaffold}`);
  // Load the complete starter before modifying the destination.
  const team = await projectProfiles({ root, templates, library, teamIds });
  const files = {
    'ALP.md': await template('ALP.md'),
    '.alp/settings.json': JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho' }, team, templateDefaults: profileDefaults(team) }, null, 2) + '\n',
  };
  const directories = ['.alp'];
  const created = [];
  const preserved = [];
  const updated = [];
  await mkdir(root, { recursive: true });
  for (const directory of directories) {
    const target = path.join(root, directory);
    try {
      await mkdir(target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lstat(target)).isDirectory()) throw new Error(`Expected a directory: ${target}`);
    }
  }
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    try {
      await writeFile(target, content, { flag: 'wx' });
      created.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lstat(target)).isFile()) throw new Error(`Expected a regular file: ${target}`);
      preserved.push(name);
      if (name === '.alp/settings.json' && syncProfiles) {
        const before = await readFile(target, 'utf8');
        const settings = JSON.parse(before);
        validateSettings(settings, target);
        const next = !onlyManagedProfiles || settings.team || settings.profile || settings.templateDefaults ? await syncTemplateProfiles(settings, { root, library, templates, teamIds }) : settings;
        validateSettings(next, target);
        if (JSON.stringify(next) !== JSON.stringify(settings)) {
          if (await readFile(target, 'utf8') !== before) throw new Error(`File changed during initialization: ${target}`);
          await writeFile(target, JSON.stringify(next, null, 2) + '\n');
          updated.push(name);
        }
      }
    }
  }
  return { created, preserved, ...(updated.length ? { updated } : {}) };
}

/** Refresh an existing project's settings only; a template Save must not scaffold unrelated folders.
 * @param {string} projectRoot
 * @param {{ library?: string, templates?: Record<string, string>, teamIds?: string[], replaceModels?: boolean }} [options]
 */
export async function syncProjectSettings(projectRoot, { library, templates, teamIds, replaceModels = false } = {}) {
  const root = path.resolve(projectRoot);
  const file = path.join(root, '.alp/settings.json');
  const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return false;
  if (!info.isFile()) throw new Error(`Expected a regular file: ${file}`);
  const before = await readFile(file, 'utf8');
  const settings = JSON.parse(before);
  validateSettings(settings, file);
  const next = await syncTemplateProfiles(settings, { root, library, templates, teamIds, replaceModels });
  validateSettings(next, file);
  if (JSON.stringify(settings) === JSON.stringify(next)) return false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: info.mode });
    if (await readFile(file, 'utf8') !== before) throw new Error(`Settings changed while saving the template: ${file}`);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return true;
}
