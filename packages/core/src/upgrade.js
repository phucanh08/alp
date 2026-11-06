import { shippedTemplateRoot } from './template-path.js';
import { projectProfiles, normalizeAgentProfiles, syncTemplateProfiles } from './profiles.js';
import { readFile, writeFile, mkdir, mkdtemp, lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initProject } from './init.js';
import { validateSettings } from './validation.js';
import { resolveDelegation } from './delegation.js';

const legacy = {
  'ALP.md': '# Project instructions\n\nAdd project-wide instructions here.\n',
  '.alp/agents/main/AGENT.md': '# Main agent\n\nHelp with tasks in this project.\n',
};
// SHA-256 of shipped role definitions after CRLF normalization. Custom
// definitions do not match and remain untouched. Keep historical IDs immutable.
//
// A project only receives a new role definition when the copy it holds is listed here, so a version
// ALP once shipped and never listed is stranded as customInstructions for ever (t-1293). The second
// block of each list is every distinct content `templates/<file>` ever had in this repository, in
// commit order, with the commit it first appeared in; the first block is what earlier releases (and
// the pre-fork Paseo team-v1 lineage) listed by hand. Append only, never edit or remove a line.
// To extend after changing a template, take the hash of the content being replaced:
//   git show <commit>:templates/agents/supervisor/AGENT.md |
//     node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>console.log(require("crypto").createHash("sha256").update(d.replaceAll("\r\n","\n")).digest("hex")))'
const teamV1 = {
  'ALP.md': ['c2785aac6538d10e79bd6fb59b11066ccdec77287edf950fad59aa57bf3417f1', '0875293195d35d965effb70bb150d1edbc789f66f72c545f7760dea4346b1a9a', 'fe0d5e6f64ef5a5030ee99feaf083f062a8e5136ac52d451e2ca7cdacb21d14f',
    'e04fe558a26d6e3c9b08211c426a83c368e4f0d15b0929e55df8ab4e5c4bb932', // 61181b5
    'ff1a7da448b735a9b4f88e3d9b6006d048114d3becee96a331d225b63e453c56', // ca2a971
    '263135a3139eb40501f6e502271e946ec3db4692b63e39c2dd349ac0aaae6d62', // 818ab2e
    'e855f56ca0af0691c731ac5f2eb93d2528e339f2dbfd6f2376594f878d2c11e1', // 1f827c6
    'ee64975f96b8f6c9275037d2a19e86407de8354bddd6c49428070efe53ce5c7d'], // architecture review slice 1
  '.alp/agents/main/AGENT.md': ['15d217cbc5ede782790d1086124598d9a2b5ff13bcf971a37231962fcef1b47c', 'e7201a1ed7800d7500b5c8091bd8a435aa9d5138f247c2b02b8bf76299387c90', '5001b807bbb686aa1a3b7ecadf9501428909e052e8231281454fd41cbe0ebf27', '90f9903fcc97ddf6336e1a28b81103dddc60a6038dcf74d326be8998862cb022', '9085ab906e2744a4151ae5c63dd66a545115cd4c876be1fd80f0a0ed4e623da8', 'fb55cfb0852d07592090de2c49e6c5c2b57936cbffc823dd24767c2db5e5f7fb', '91b71f5750e75f707488b70618e1d65a63aabf7518762f97ea0fde999d36fead',
    '60d92fa634e178244a38e99c074e169af1847d7512e268262148ec15ebf08bed', // 61181b5
    'b501142ebff430e2ac6d0c3ecb2673cbf0fe0e1fa123b73b113ba9b4aa5f3a39', // ca2a971
    'ddbd75ebacf5f13615fa3da4941a389b14b534742032c3046e0e6c214a46c989', // ec26e6c
    '5d610e7639bc8eaa29ad4119a5c090cbd286bd217f2f4a7d3abdd59725a985c1', // a1acd92
    '28037d678457a392a42510d57919b14a643ea729c2a358fa7aeee4b7a33e6727', // 8d0e12a
    'b4435cf5ef8cfab2238eee86298f21cfa508e3fdeb6b3e697fde94160c341fe7', // 105f68f
    '973539ce5dd998440cb59938f37260760f96f66a67b66369fcb28421acd49903', // 40ce2de
    'ab85e561f62a46e8838cc955984b66583a7325e69c1e7f2fd049479241553751', // cc9215e
    '8b8d0bff45d245543f543ecd15043be38fd03edd364c6750aac58b87785c1afa', // 818ab2e
    '2e82f110b108032c3c4444c306e73409bb6b481e5dc9ab080fe1ee2eb583fb78', // b8d2fbc
    'cde93f41883b26c2ef7636735d88be8fb202b143c479821647799c83b7d673dc', // 9180aa1
    '29f181001edfee5521d8f4965b33f501f8ef869f6af3abf74a05e5f1623809ac', // f4d7986
    'd6f8002a81e3e0b7bb5868a6834d7be37731cc307877d7a03513067be10cad2f', // 1f827c6
    'b9bdd073e22903e3813f13caf87c9341215476ed692b3f04bc0971b66fd93ac5'], // architecture review slice 1
  '.alp/agents/lead/AGENT.md': ['c259b085a3c102445f97e5c7d402ca68347bcc1a9b02d6ab96e02be6d8b6f9af', '2eef2a4474f757cd89b35b50638a1b23fe49a54c26bf0dedb24a96d7117ddd92', '6c71393c9b3aa655c4731bda96396ea3ec0d4da62cddb3ad50d1a24113416b77', 'a382f0faa724e23a0ba9c212205978aa3fef87c3aecdf8823fba136e04568487', '547e3f8fc354b22c7beb3432182d68f4de1f24938375c8bfb167ae8afbf97de2', 'f3609df1486c0911459d8ee7d823b344369df0538654b0de6e9bc23170186b22',
    '1674d7b96450824111ce885c828af51aa8924c38888bdeb583f4f31684c2bf60', // 61181b5
    '7cd01a44200fda79ae0979a4975c483494a35e2e8c144b4e56f0b61046fc1a67', // ca2a971
    'c622392fcb94aeec18efcb12fe9ed574117304af02c303d0f575a2181991b454', // 8d0e12a
    '6e9166b3b72333b76b4b2ef5a7778e142d6fd3c1023efd8a792bec1b12516415', // 40ce2de
    '8aef2591deb1ca12f3cbc843445688140aeb03f7c42bff8e15ef74bdd03be940', // 1f827c6
    'e241608ee9579ed894024cba8f9b7b60e75283179d68ebbd4cb28a526c78965d'], // architecture review slice 1
  '.alp/agents/peer/AGENT.md': ['f3dcf16c8c899a5378a468e922ca3956fd72cbb3e3798ed1109f11e01aa8f476', '39ccf3317eba3003faad77ebad4489fae3eb3c4d89258a03f619d1d3d65af0b7', 'c59e45e8f22eb0daca9b8b5e1b19e90666156807f160e75a21eca48b5fee1102', '9623dbf76eda598f6267629e993663c149acb0efd253f3900a4ee1eda8f2f9e7', '20b0d2b6be74597ea1f39cf6d2d56c0ef2bffe39cb3bfe1ae41761748ef9bfae',
    'da389b7fa194fcf4cb8683664d30e06197999d804ec4ee94c1889bb397f540a9', // 61181b5
    'c7c8f4c5468484bab165f8f32b141398a259d4e6e9966e304528d82858e6807e', // ca2a971
    'd7cbdac679c82086ce2601d0a2c82480f6b2300ea011a9e07862f1b900d6ac75'], // 1f827c6
  '.alp/agents/oracle/AGENT.md': ['cdce1babcd587a190dc94a32a951ed70ce2c75f99c205a4049df940851ac7059', '0907091b17aa8e54215b65171433f222b8491e9490a16a66b6a2b8cffc3f9023',
    'ae6219e0141d290705ed45992f0cc78688d17c78757f7f1f72f1639432e110cc'], // 1f827c6
  '.alp/agents/reviewer/AGENT.md': ['6eab9f918c79335a0665bf4e3a3a26b66258684d6725c4c95637e70e8d355123', '1809de0be6473d5f9ceeae2d35128d52a0c0cde3968b45a7569ceae7a8a74416',
    '56bebc192fda9d67bc2ceaf14d4f0cf274eaa40bf3e652caaf85c239eba1a253'], // 1f827c6
  '.alp/agents/supervisor/AGENT.md': ['81ac93f4fbf2337224f838d39a9c4ef13fdba12d5fc7de681a00628bf9e69a27',
    'a2be7e682b030d2ff122ba4e836b1c89858493a05937fa11ad1fa808e0df9c8d', // 61181b5
    'd26d642128bedb6c90d4a84b227877ae4ea8be0838de75f40d786c0ba55183ae', // ec26e6c
    'f920b505cda38c90f7014827352225846b6b1e35a40675e2f5d01b03cee250ce', // cdbc297
    '10e22e451264a901a7ad62e04189a91fae70940a62f4646f22c1135244986d03', // cc9215e
    '6c306170ee5218313c93dc8bc1049e1dd9daf401073fda4c476ff4b5630765ab'], // 1f827c6
};
/** The hashes above, by project-relative path, so a test can hold the list to the templates. */
export const shippedRoleHashes = teamV1;

/** Profiles' names before 0.4. */
const renamedProfiles = { smart: 'pho', supervised: 'cafe' };

/** A skill directory's regular files by relative path, CRLF-normalized; undefined when absent or not plain files. */
async function skillFiles(directory) {
  const files = new Map();
  async function walk(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!await walk(name)) return false; }
      else if (entry.isFile()) files.set(name, (await readFile(path.join(directory, name), 'utf8')).replaceAll('\r\n', '\n'));
      else return false;
    }
    return true;
  }
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return await walk('') ? files : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Explicit migration of the original scaffold; custom instructions remain owned by the user. */
export async function upgradeProject(projectRoot, { library, templates } = {}) {
  const root = path.resolve(projectRoot);
  // Validate before creating files or changing settings.
  let settingsText;
  try { settingsText = await readFile(path.join(root, '.alp/settings.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = settingsText === undefined ? undefined : JSON.parse(settingsText);
  if (settings !== undefined) validateSettings(settings, '.alp/settings.json');
  await resolveDelegation(root);
  const result = { ...await initProject(root, { library, templates, syncProfiles: false }), updated: [], removed: [], customSkills: [], customInstructions: [], backup: undefined };
  async function backupPath(name) {
    if (!result.backup) {
      const backups = path.join(root, '.alp/backups');
      await mkdir(backups, { recursive: true });
      result.backup = await mkdtemp(path.join(backups, 'upgrade-'));
    }
    const backup = path.join(result.backup, name);
    await mkdir(path.dirname(backup), { recursive: true });
    return backup;
  }
  async function replace(name, before, after) {
    const target = path.join(root, name);
    if (!(await lstat(target)).isFile() || await readFile(target, 'utf8') !== before) throw new Error(`File changed during upgrade: ${target}`);
    const backup = await backupPath(name);
    await writeFile(backup, before, { flag: 'wx' });
    await writeFile(target, after);
    result.updated.push(name);
  }
  for (const name of ['ALP.md']) {
    const current = await readFile(path.join(root, name), 'utf8');
    const template = name === 'ALP.md' ? 'ALP.md' : name.slice('.alp/'.length);
    const desired = await readFile(new URL(`${template}`, shippedTemplateRoot()), 'utf8');
    const normalized = current.replaceAll('\r\n', '\n');
    const known = normalized === legacy[name] || teamV1[name]?.includes(createHash('sha256').update(normalized).digest('hex'));
    if (current !== desired && known) await replace(name, current, desired);
    else if (current !== desired) result.customInstructions.push(name);
  }
  const oldGraph = settings?.delegation;
  const shippedGraph = oldGraph && Object.keys(oldGraph).length === 2 && JSON.stringify(oldGraph.main) === '["lead"]' && JSON.stringify(oldGraph.lead) === '["peer"]';
  if (settings !== undefined) {
    let next = structuredClone(settings);
    if (next.workflow === undefined && (oldGraph === undefined || shippedGraph)) {
      if (shippedGraph) delete next.delegation;
      next.workflow = { mode: shippedGraph ? 'cafe' : 'pho', maxPeers: 2 };
    } else if (Object.hasOwn(renamedProfiles, next.workflow?.mode)) next.workflow.mode = renamedProfiles[next.workflow.mode];
    next.team = next.team || next.profile
      ? { ...(next.profile ?? {}), ...(next.team ?? {}) }
      : await projectProfiles({ root, library, templates, runtime: next.runtime });
    delete next.profile;
    for (const profile of Object.values(next.team ?? {})) {
      for (const [name, config] of Object.entries(profile)) profile[name] = normalizeAgentProfiles(config, name);
    }
    next = await syncTemplateProfiles(next, { root, library, templates });
    validateSettings(next, '.alp/settings.json');
    if (JSON.stringify(next) !== JSON.stringify(settings)) await replace('.alp/settings.json', settingsText, JSON.stringify(next, null, 2) + '\n');
  }
  // Skills now come from the user's library; archive project copies that still match what ALP shipped.
  const shipped = JSON.parse(await readFile(new URL('role-skills.json', shippedTemplateRoot()), 'utf8'));
  for (const [role, skills] of Object.entries(shipped)) {
    for (const skill of skills) {
      const relative = `.alp/agents/${role}/skills/${skill}`;
      const files = await skillFiles(path.join(root, relative));
      if (!files) continue;
      const template = await skillFiles(fileURLToPath(new URL(`skills/${skill}`, shippedTemplateRoot())));
      const same = template && files.size === template.size && [...files].every(([name, text]) => template.get(name) === text);
      if (!same) { result.customSkills.push(relative); continue; }
      for (const name of files.keys()) await rename(path.join(root, relative, name), await backupPath(`${relative}/${name}`));
      await rm(path.join(root, relative), { recursive: true });
      result.removed.push(relative);
    }
  }
  // Retire only the exact previously shipped router; archive it outside discovery.
  for (const role of ['main', 'lead', 'peer']) {
    const relative = `.alp/agents/${role}/skills/ask-alp`;
    const directory = path.join(root, relative);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) { result.customSkills.push(relative); continue; }
      const names = await readdir(directory);
      const file = path.join(directory, 'SKILL.md');
      if (names.length !== 1 || names[0] !== 'SKILL.md' || !(await lstat(file)).isFile()) { result.customSkills.push(relative); continue; }
      const content = await readFile(file, 'utf8');
      const hash = createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');
      if (hash !== 'f38128fafa2e8a75a0237a2fda9a71fc92ed3f1e0e62878db50e5a07376f2108') { result.customSkills.push(relative); continue; }
      await rename(file, await backupPath(`${relative}/SKILL.md`));
      await rmdir(directory);
      result.removed.push(relative);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await retireAgentCopies(root, result, backupPath, replace);
  return result;
}

const known = (name, text) => {
  const normalized = text.replaceAll('\r\n', '\n');
  return normalized === legacy[name] || teamV1[name]?.includes(createHash('sha256').update(normalized).digest('hex'));
};

/** An agent directory's entries apart from AGENT.md, when they hold nothing: an empty .mcp.json and empty skills/ and hooks/. */
async function onlyInstructions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'AGENT.md' && entry.isFile()) continue;
    if (entry.name === '.mcp.json' && entry.isFile()) {
      try { const mcp = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8')); if (!Object.keys(mcp.mcpServers ?? {}).length && Object.keys(mcp).every(key => key === 'mcpServers')) continue; } catch {}
      return false;
    }
    if ((entry.name === 'skills' || entry.name === 'hooks') && entry.isDirectory() && !(await readdir(path.join(directory, entry.name))).length) continue;
    return false;
  }
  return true;
}

/**
 * Projects used to get a copy of each built-in agent (ALPD §41). A copy that is still
 * what ALP shipped, with nothing added, is backed up and removed, so the project uses
 * the built-in and its updates. A shipped copy the user added skills, MCP servers or
 * hooks to stays as the project's override, with its instructions brought up to date;
 * customized instructions stay as they are.
 */
async function retireAgentCopies(root, result, backupPath, replace) {
  for (const name of ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor']) {
    const relative = `.alp/agents/${name}`;
    const directory = path.join(root, relative);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const file = `${relative}/AGENT.md`;
    const current = await readFile(path.join(root, file), 'utf8').catch(() => undefined);
    if (current === undefined) continue;
    const desired = await readFile(new URL(`agents/${name}/AGENT.md`, shippedTemplateRoot()), 'utf8');
    const shipped = current === desired || known(file, current);
    if (!shipped) { result.customInstructions.push(file); continue; }
    if (await onlyInstructions(directory)) {
      // Its empty skills/ and hooks/ go; its files go to the backup, beside any skills archived above.
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await rmdir(path.join(directory, entry.name));
        else await rename(path.join(directory, entry.name), await backupPath(`${relative}/${entry.name}`));
      }
      await rmdir(directory);
      result.removed.push(relative);
    } else if (current !== desired) {
      await replace(file, current, desired);
    }
  }
  await rmdir(path.join(root, '.alp/agents')).catch(() => {});
}
