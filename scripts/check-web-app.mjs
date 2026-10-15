#!/usr/bin/env node
// Before packing the optional plugin: verify its web app against the pinned Paseo commit and
// paseo-web/patches. Core packages do not carry or require this artifact.
// Build it with scripts/build-paseo-web.mjs.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const upstream = JSON.parse(await readFile(path.join(root, 'paseo-web/upstream.json'), 'utf8'));
const patches = (await readdir(path.join(root, 'paseo-web/patches'))).filter(name => name.endsWith('.patch')).sort();
const problems = [];
for (const target of ['integrations/paseo/server/dist/web-app']) {
  const built = await readFile(path.join(root, target, 'alp-web-app.json'), 'utf8').then(JSON.parse, () => undefined);
  if (!built) { problems.push(`${target} is missing`); continue; }
  if (built.paseoCommit !== upstream.commit) problems.push(`${target} is built from Paseo ${built.paseoCommit.slice(0, 7)}, not ${upstream.commit.slice(0, 7)}`);
  if (JSON.stringify(built.patches) !== JSON.stringify(patches)) problems.push(`${target} is built with other patches than paseo-web/patches`);
  await readFile(path.join(root, target, 'index.html')).catch(() => problems.push(`${target}/index.html is missing`));
}
if (problems.length) {
  console.error(`The ALP web app is not ready to pack:\n- ${problems.join('\n- ')}\nBuild it with: node scripts/build-paseo-web.mjs`);
  process.exit(1);
}
console.log(`ALP web app ready: Paseo ${upstream.version} (${upstream.commit.slice(0, 7)}) with ${patches.length} patches`);
