// For the ALP web app (Paseo packages/app Expo web export shipped in @anhlp/alp-paseo):
// 1) lists the exported files, 2) computes the prod dependency closure of packages/app in the
// Paseo lockfile, 3) intersects it with the high/critical advisories from npm audit of that lockfile.
// Usage: node web-app-closure.mjs <alpRoot> <paseoRoot> <paseoAudit.json> <out.json>
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [alpRoot, paseoRoot, auditPath, outPath] = process.argv.slice(2);
const NM = 'node' + '_modules';
const webDir = path.join(alpRoot, 'integrations/paseo/server', 'di' + 'st', 'web-app');
const files = [];
try {
  for (const f of readdirSync(webDir, { recursive: true })) {
    const full = path.join(webDir, String(f));
    if (statSync(full).isFile() && !/\.(br|gz)$/.test(full)) files.push({ file: String(f).replaceAll('\\', '/'), size: statSync(full).size });
  }
} catch (e) { files.push({ error: String(e) }); }

const lock = JSON.parse(readFileSync(path.join(paseoRoot, 'package-lock.json'), 'utf8')).packages;
function resolve(from, name) {
  let dir = from;
  for (;;) {
    const cand = (dir ? dir + '/' : '') + NM + '/' + name;
    if (lock[cand]) return lock[cand].link ? lock[cand].resolved : cand;
    if (!dir) return null;
    const i = dir.lastIndexOf('/' + NM + '/');
    dir = i >= 0 ? dir.slice(0, i) : '';
  }
}
const seen = new Map();
const queue = [['packages/app', null]];
while (queue.length) {
  const [p, via] = queue.shift();
  if (seen.has(p)) continue;
  seen.set(p, via);
  const m = lock[p] || {};
  for (const n of [...Object.keys(m.dependencies || {}), ...Object.keys(m.optionalDependencies || {}), ...Object.keys(m.peerDependencies || {})]) {
    const r = resolve(p, n);
    if (r) queue.push([r, p]);
  }
}
const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const hits = [];
for (const [name, v] of Object.entries(audit.vulnerabilities)) {
  const direct = v.via.filter((x) => typeof x !== 'string' && ['high', 'critical'].includes(x.severity));
  if (!direct.length) continue;
  for (const node of v.nodes) {
    if (!seen.has(node)) continue;
    const chain = [];
    for (let q = node; q; q = seen.get(q)) chain.unshift(q.replace(/^.*node_modules\//, ''));
    hits.push({ name, version: lock[node]?.version, dev: !!lock[node]?.dev, node, advisories: direct.map((x) => `${x.severity} ${x.url.split('/').pop()} ${x.range}`), chain: chain.join(' > ') });
  }
}
writeFileSync(outPath, JSON.stringify({ webFiles: files, closureSize: seen.size, hits }, null, 1));
console.log('web-app files:', files.length, files.filter((f) => /\.(js|map)$/.test(f.file || '')).map((f) => `${f.file}(${f.size})`).slice(0, 15).join(' '));
console.log('packages/app prod closure:', seen.size);
for (const h of hits) console.log(`${h.name}@${h.version} :: ${h.advisories.length} adv [${[...new Set(h.advisories.map((a) => a.split(' ')[0]))]}] :: ${h.chain}`);
