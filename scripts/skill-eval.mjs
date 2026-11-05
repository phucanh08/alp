#!/usr/bin/env node
// Skill evaluation (skill system v2).
//
//   node scripts/skill-eval.mjs disclosure [--templates DIR] [--json]
//     Measures progressive disclosure with ALP's own resolver and instruction adapter: for each role,
//     the Level 0 skill index its session starts with, against the skill bodies, references and
//     scripts it could open but is not given. Character counts are measured; tokens are an estimate
//     (characters / 4) and labelled so. --templates points at another templates directory (a
//     baseline, e.g. `git archive main templates | tar -x -C /tmp/base`).
//
//   node scripts/skill-eval.mjs triggers [--live] [--model M] [--json]
//     Checks test/evals/skills/triggers.json against the shipped role mapping (every expected skill is
//     the role's; every forbidden one names a real skill). With --live it asks a model, given only a
//     role's Level 0 index and a task, which skills it would open, and scores the answers. --live calls
//     the Claude API (it costs money and needs credentials), so it never runs by default.
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { resolveAgent } from '@anhlp/alp-core/resolver';
import { InstructionsAdapter } from '@anhlp/alp-runtime';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const estimate = chars => Math.round(chars / 4);

async function sizeOf(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/** The roles of a templates directory, each with the skills its session indexes and what stays unread. */
/** Writes each of `homes` in `text` as `~/.alp`. @param {string} text @param {string[]} homes */
const homeAsAlp = (text, homes) => homes.reduce((out, home) => out.split(home).join('~/.alp'), text);

export async function disclosure(templates = path.join(ROOT, 'templates')) {
  const work = await mkdtemp(path.join(tmpdir(), 'alp-skill-eval-'));
  try {
    const library = path.join(work, 'home');
    const project = path.join(work, 'project');
    await seedLibrary(library, { templateRoot: pathToFileURL(templates + path.sep) });
    await initProject(project);
    const homes = [...new Set([library, await realpath(library)])].sort((a, b) => b.length - a.length);
    const roles = JSON.parse(await readFile(path.join(templates, 'role-skills.json'), 'utf8'));
    const rows = [];
    for (const role of Object.keys(roles)) {
      const agent = await resolveAgent(project, { agent: role, library });
      const compiled = await new InstructionsAdapter().compile(agent);
      const instructions = compiled.material.instructions;
      // Measured with the temporary home written as ~/.alp, so the size does not depend on where the
      // OS keeps temporary directories (macOS's are about 60 characters longer than Linux's).
      const index = agent.skills.length ? homeAsAlp(instructions.slice(instructions.indexOf('Your skills:')), homes) : '';
      let bodies = 0, resources = 0, leaked = 0;
      for (const skill of agent.skills) {
        const body = await readFile(skill.path, 'utf8');
        bodies += Buffer.byteLength(body);
        resources += (await sizeOf(path.dirname(skill.path))) - Buffer.byteLength(body);
        // A body's first instruction line must not be in the session's instructions.
        const firstLine = body.replace(/^---[\s\S]*?---\s*/, '').split('\n').find(line => line.trim().length > 20);
        if (firstLine && instructions.includes(firstLine)) leaked++;
      }
      rows.push({ role, skills: agent.skills.length, indexChars: index.length, indexTokensEstimate: estimate(index.length), bodyBytesNotLoaded: bodies, resourceBytesNotLoaded: resources, bodiesInInstructions: leaked });
    }
    return rows;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function loadScenarios() {
  return JSON.parse(await readFile(path.join(ROOT, 'test/evals/skills/triggers.json'), 'utf8')).scenarios;
}

/** Static checks: scenarios are consistent with the shipped mapping. Returns problems found. */
export async function checkScenarios() {
  const roles = JSON.parse(await readFile(path.join(ROOT, 'templates/role-skills.json'), 'utf8'));
  const known = new Set((await readdir(path.join(ROOT, 'templates/skills'))));
  const problems = [];
  for (const scenario of await loadScenarios()) {
    const own = roles[scenario.role];
    if (!own) { problems.push(`${scenario.id}: unknown role ${scenario.role}`); continue; }
    for (const skill of scenario.expect) if (!own.includes(skill)) problems.push(`${scenario.id}: expects ${skill}, which ${scenario.role} does not have`);
    for (const skill of scenario.forbid) if (!known.has(skill)) problems.push(`${scenario.id}: forbids unknown skill ${skill}`);
    if (scenario.expect.some(skill => scenario.forbid.includes(skill))) problems.push(`${scenario.id}: a skill is both expected and forbidden`);
  }
  return problems;
}

/** Asks a model, for each scenario, which skills of the role's index it would open. */
async function liveTriggers(model) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const work = await mkdtemp(path.join(tmpdir(), 'alp-skill-eval-'));
  const results = [];
  try {
    const library = path.join(work, 'home');
    const project = path.join(work, 'project');
    await seedLibrary(library);
    await initProject(project);
    for (const scenario of await loadScenarios()) {
      const agent = await resolveAgent(project, { agent: scenario.role, library });
      const index = (await new InstructionsAdapter().compile(agent)).material.instructions;
      const skills = index.slice(index.indexOf('Your skills:'));
      const response = await client.messages.create({
        model, max_tokens: 2000,
        system: `You are an ALP ${scenario.role} agent. ${skills}\n\nAnswer only with a JSON array of the skill names you would open before starting the task, [] for none.`,
        messages: [{ role: 'user', content: scenario.task }],
      });
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
      let chosen = [];
      try { chosen = JSON.parse(/\[[\s\S]*?\]/.exec(text)?.[0] ?? '[]'); } catch {}
      const missing = scenario.expect.filter(skill => !chosen.includes(skill));
      const forbidden = scenario.forbid.filter(skill => chosen.includes(skill));
      results.push({ id: scenario.id, kind: scenario.kind, role: scenario.role, chosen, pass: !missing.length && !forbidden.length, missing, forbidden, stop: response.stop_reason });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command] = argv;
  if (command === 'disclosure') {
    const rows = await disclosure(option('--templates') ? path.resolve(option('--templates')) : undefined);
    if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log('role        skills  index chars  ~index tokens  bodies not loaded (B)  resources not loaded (B)  bodies leaked');
      for (const r of rows) console.log(`${r.role.padEnd(11)} ${String(r.skills).padStart(6)}  ${String(r.indexChars).padStart(11)}  ${String(r.indexTokensEstimate).padStart(13)}  ${String(r.bodyBytesNotLoaded).padStart(21)}  ${String(r.resourceBytesNotLoaded).padStart(24)}  ${String(r.bodiesInInstructions).padStart(13)}`);
      console.log('Tokens are an estimate (characters / 4); characters and bytes are measured.');
    }
  } else if (command === 'triggers') {
    const problems = await checkScenarios();
    for (const problem of problems) console.log(`scenario problem: ${problem}`);
    if (problems.length) process.exitCode = 1;
    else if (!argv.includes('--live')) console.log(`${(await loadScenarios()).length} scenarios consistent with templates/role-skills.json. Model-graded run not done: pass --live (calls the Claude API; costs money).`);
    else {
      const results = await liveTriggers(option('--model') ?? 'claude-opus-5-5');
      if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
      else for (const r of results) console.log(`${r.pass ? 'pass' : 'FAIL'} ${r.id} (${r.kind}, ${r.role}): chose ${JSON.stringify(r.chosen)}${r.missing.length ? `; missing ${r.missing}` : ''}${r.forbidden.length ? `; forbidden ${r.forbidden}` : ''}`);
      console.log(`${results.filter(r => r.pass).length}/${results.length} passed`);
    }
  } else {
    console.error('Usage: skill-eval.mjs disclosure [--templates DIR] [--json] | triggers [--live] [--model M] [--json]');
    process.exitCode = 2;
  }
}
