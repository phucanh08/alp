import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * alp_skill_read (t-4b59): an agent's own skill files, for a runtime whose file tools cannot reach
 * them. Headless agy in workspace-write denies every read outside the workspace, and the library
 * skills live in <ALP_HOME>/skills, so an Antigravity role that followed "read its SKILL.md" lost
 * its whole turn. This returns a file only from the directory of a skill the calling agent
 * resolved itself: no other skill, no path outside that directory after links are followed, no
 * hidden entry, and no file over the size cap. agy's own permissions are not changed.
 */

/** The largest skill file returned, in bytes; a skill's guide recommends far less. */
export const SKILL_FILE_BYTES = 256 * 1024;
/** How many of a skill's files its SKILL.md answer lists, and how deep it looks for them. */
const LISTED_FILES = 200;
const LISTED_DEPTH = 4;
const FILE_CHARS = 512;

/**
 * Whether a session reads its skills with alp_skill_read instead of its file tools: Antigravity,
 * whose agy denies reads outside the workspace in workspace-write and may in read-only. Claude
 * loads skills natively and Codex reads them with its own tools, so they keep the file paths.
 */
export const readsSkillsByTool = (runtimeKind: string | undefined, skills: readonly unknown[]) => runtimeKind === 'antigravity' && skills.length > 0;

/** Whether the supervisor may call `tool`: alp_send, alp_board and alp_task, and alp_skill_read where its skills need it. */
export const supervisorMayCall = (tool: string, runtimeKind: string | undefined, skills: readonly unknown[]) =>
  ['alp_send', 'alp_board', 'alp_task'].includes(tool) || (tool === 'alp_skill_read' && readsSkillsByTool(runtimeKind, skills));

export type SkillRef = { name: string; path: string };
export type SkillFile = { skill: string; file: string; bytes: number; content: string; files?: string[] };
export type SkillFileResult = { ok: true; value: SkillFile } | { ok: false; error: string };

const refuse = (error: string): SkillFileResult => ({ ok: false, error });

/** Whether `child` is a path strictly inside `parent`; both are real (link-free) paths. */
function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The files of a skill directory other than SKILL.md, relative, with `/`; hidden entries and links skipped. */
async function skillFiles(directory: string) {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= LISTED_FILES || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < LISTED_DEPTH) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const relative = path.relative(directory, full).split(path.sep).join('/');
        if (relative !== 'SKILL.md') found.push(relative);
      }
    }
  };
  await walk(directory, 1);
  return found;
}

/**
 * One file of one of `skills`, by skill name and a path relative to that skill's directory
 * (default SKILL.md). Refused: a skill not in `skills`, an absolute path, a hidden entry, a path
 * that leaves the skill's directory (also through a link), a directory, a file over
 * SKILL_FILE_BYTES, and a binary file. The answer for SKILL.md also lists the skill's other files.
 * A SKILL.md that is itself a link to a file outside its directory is refused too: ALP's library
 * keeps no links in a skill (library-edit), and following one would read outside the skill.
 */
export async function readSkillFile(skills: readonly SkillRef[], args: unknown, { maxBytes = SKILL_FILE_BYTES } = {}): Promise<SkillFileResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.keys(args).every(key => key === 'skill' || key === 'file')) return refuse('alp_skill_read takes {skill, file?}');
  const { skill: name, file: requested = 'SKILL.md' } = args as { skill?: unknown; file?: unknown };
  if (typeof name !== 'string' || !name) return refuse('Name the skill: one of yours from your instructions');
  const skill = skills.find(candidate => candidate.name === name);
  if (!skill) return refuse(skills.length ? `'${name}' is not one of your skills: ${skills.map(candidate => candidate.name).join(', ')}` : 'You have no skills');
  if (typeof requested !== 'string' || !requested || requested.length > FILE_CHARS || requested.includes('\0')) return refuse('file must be a path inside the skill, such as SKILL.md or references/guide.md');
  const relative = requested.replace(/\\/g, '/');
  if (path.isAbsolute(requested) || path.win32.isAbsolute(requested) || relative.startsWith('/')) return refuse('file must be relative to the skill\'s directory, such as references/guide.md');
  const parts = relative.split('/').filter(part => part !== '' && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) return refuse(`file must stay inside skill '${name}'`);
  if (parts.some(part => part.startsWith('.'))) return refuse('Hidden files of a skill are not returned');

  let directory: string;
  try { directory = await realpath(path.dirname(skill.path)); }
  catch { return refuse(`Skill '${name}' is no longer on disk`); }
  let target: string;
  try { target = await realpath(path.join(directory, ...parts)); }
  catch { return refuse(`Skill '${name}' has no file ${parts.join('/')}`); }
  if (!inside(directory, target)) return refuse(`file must stay inside skill '${name}'`);

  // Only a regular file is opened (a FIFO would block the open), and not through a link swapped in
  // since realpath (O_NOFOLLOW where the platform has it); the open file is checked again.
  const notFile = refuse(`${parts.join('/')} in skill '${name}' is not a file`);
  if (!(await stat(target).then(found => found.isFile(), () => false))) return notFile;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(target, flags).catch(() => undefined);
  if (!handle) return refuse(`Skill '${name}' has no readable file ${parts.join('/')}`);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return notFile;
    if (stats.size > maxBytes) return refuse(`${parts.join('/')} in skill '${name}' has ${stats.size} bytes; ALP returns at most ${maxBytes}`);
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = stats.size ? await handle.read(buffer, 0, stats.size, 0) : { bytesRead: 0 };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return refuse(`${parts.join('/')} in skill '${name}' is binary; only text files are returned`);
    const file = parts.join('/');
    return { ok: true, value: { skill: name, file, bytes: bytesRead, content: bytes.toString('utf8'), ...(file === 'SKILL.md' ? { files: await skillFiles(directory) } : {}) } };
  } finally {
    await handle.close();
  }
}
