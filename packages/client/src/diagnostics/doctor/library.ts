import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateSkill } from '@anhlp/alp-core/skill-validate';
import { settingsWarnings, validateUserSettings } from '@anhlp/alp-core/validation';
import type { DoctorCheck } from './types.ts';

export async function userSettingsCheck(home: string): Promise<DoctorCheck> {
  const file = path.join(home, 'settings.json');
  try {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return { id: 'user settings', status: 'ok', summary: `none (${file})` };
    const settings = JSON.parse(text);
    validateUserSettings(settings, file);
    const warnings = settingsWarnings(settings, 'user');
    return warnings.length
      ? { id: 'user settings', status: 'warn', summary: `${file}: ${warnings.length} key${warnings.length > 1 ? 's' : ''} ALP ignores`, details: warnings }
      : { id: 'user settings', status: 'ok', summary: file };
  } catch (error) {
    return { id: 'user settings', status: 'fail', summary: `alpd ignores ${file}: ${(error as Error).message.replace(`${file}: `, '')}` };
  }
}

/**
 * The library's skills against the skill format, in legacy mode: a format problem is a warning
 * (the skill still loads), an unsafe reference or link an error. Nothing is rewritten.
 */
export async function skillFormatCheck(home: string): Promise<DoctorCheck | undefined> {
  const directory = path.join(home, 'skills');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const failed: string[] = [];
  const warned: string[] = [];
  let checked = 0;
  for (const entry of entries) {
    // The skills the resolver loads: a plain directory name holding SKILL.md (not .git or notes).
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !/^[\w.-]+$/.test(entry.name) || entry.name.startsWith('.')) continue;
    if (!(await lstat(path.join(directory, entry.name, 'SKILL.md')).then(() => true, () => false))) continue;
    checked++;
    try {
      const report = await validateSkill(path.join(directory, entry.name));
      if (!report.ok) failed.push(`${entry.name}: ${report.errors.map(finding => finding.message).join('; ')}`);
      else if (report.warnings.length) warned.push(`${entry.name}: ${report.warnings.map(finding => finding.code).join(', ')}`);
    } catch (error) { failed.push(`${entry.name}: could not be checked: ${(error as Error).message}`); }
  }
  if (!checked) return undefined;
  if (failed.length) return { id: 'skill-format', status: 'fail', summary: `${failed.length} library skill${failed.length > 1 ? 's have' : ' has'} an unsafe link or an unreadable file (alp skill check <name> explains)`, details: [...failed, ...warned] };
  if (warned.length) return { id: 'skill-format', status: 'warn', summary: `${warned.length} library skill${warned.length > 1 ? 's do' : ' does'} not fully meet the skill format; they still load (alp skill check <name> explains)`, details: warned };
  return { id: 'skill-format', status: 'ok', summary: `the library's skills meet the skill format (${directory})` };
}

export async function librarySkillsCheck(home: string): Promise<DoctorCheck | undefined> {
  const file = path.join(home, 'role-skills.json');
  let roles;
  try {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return undefined;
    roles = JSON.parse(text);
  } catch (error) { return { id: 'skills', status: 'fail', summary: `${file}: ${(error as Error).message}` }; }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return { id: 'skills', status: 'fail', summary: `${file}: expected an object of role names to skill lists` };
  const missing: string[] = [];
  for (const [role, names] of Object.entries(roles)) {
    if (!Array.isArray(names)) { missing.push(`${role}: not a list`); continue; }
    for (const name of names) {
      if (typeof name !== 'string' || !await lstat(path.join(home, 'skills', name, 'SKILL.md')).then(() => true, () => false)) missing.push(`${role}: ${name}`);
    }
  }
  return missing.length
    ? { id: 'skills', status: 'warn', summary: `${file} lists ${missing.length} skill${missing.length > 1 ? 's' : ''} the library lacks; agents start without them`, details: missing }
    : { id: 'skills', status: 'ok', summary: `the library's skills exist (${file})` };
}
