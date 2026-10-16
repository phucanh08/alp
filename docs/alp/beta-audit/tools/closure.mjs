// Computes the install closure of each published package from package-lock.json
// (dependencies + non-optional peerDependencies, which npm >=7 auto-installs;
// optional deps included and flagged), then intersects it with npm audit output.
// Usage: node closure.mjs <repoRoot> <audit.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, auditPath, outPath] = process.argv.slice(2);
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const pkgs = lock.packages;
const NM = 'node' + '_modules';

const PUBLISHED = {
  '@anhlp/alp': '',
  '@anhlp/alp-protocol': 'packages/protocol',
  '@anhlp/alp-core': 'packages/core',
  '@anhlp/alp-runtime': 'packages/runtime',
  '@anhlp/alp-client': 'packages/client',
  '@anhlp/alp-daemon': 'packages/daemon',
  '@anhlp/alp-cli': 'packages/cli',
  '@anhlp/alp-paseo': 'integrations/paseo',
};

// Node resolution over lockfile paths: walk up from `from` looking for NM/name.
function resolve(from, name) {
  let dir = from;
  for (;;) {
    const cand = (dir ? dir + '/' : '') + NM + '/' + name;
    if (pkgs[cand]) return pkgs[cand].link ? pkgs[cand].resolved : cand;
    if (!dir) return null;
    const i = dir.lastIndexOf('/' + NM + '/');
    if (i >= 0) dir = dir.slice(0, i);
    else if (dir.startsWith(NM + '/')) dir = '';
    else dir = ''; // workspace dir -> root
  }
}

function closure(start, { peers }) {
  const seen = new Map(); // path -> {optional, via}
  const queue = [[start, false, null]];
  while (queue.length) {
    const [p, opt, via] = queue.shift();
    if (seen.has(p) && (seen.get(p).optional <= opt)) continue;
    seen.set(p, { optional: opt, via });
    const m = pkgs[p] || {};
    const edges = [
      ...Object.keys(m.dependencies || {}).map((n) => [n, false]),
      ...Object.keys(m.optionalDependencies || {}).map((n) => [n, true]),
    ];
    if (peers) {
      const meta = m.peerDependenciesMeta || {};
      for (const n of Object.keys(m.peerDependencies || {})) edges.push([n, !!meta[n]?.optional]);
    }
    for (const [n, o] of edges) {
      const r = resolve(p, n);
      if (r) queue.push([r, opt || o, p]);
    }
  }
  seen.delete(start);
  return seen;
}

const vulnByNode = new Map();
for (const [name, v] of Object.entries(audit.vulnerabilities || {})) {
  for (const node of v.nodes) vulnByNode.set(node, { name, severity: v.severity, direct: v.via.filter((x) => typeof x !== 'string').map((x) => x.url) });
}

const out = {};
for (const [name, dir] of Object.entries(PUBLISHED)) {
  for (const peers of [false, true]) {
    const c = closure(dir, { peers });
    const hits = [];
    for (const [p, info] of c) {
      const v = vulnByNode.get(p);
      if (v) {
        const chain = [];
        for (let q = p; q && q !== dir; q = c.get(q)?.via) chain.unshift(q.replace(/^.*node_modules\//, ''));
        hits.push({ node: p, version: pkgs[p]?.version, ...v, optional: info.optional, chain: chain.join(' > ') });
      }
    }
    out[`${name}${peers ? ' (+peers)' : ''}`] = { size: c.size, hits };
  }
}
writeFileSync(outPath, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) {
  console.log(`${k}: closure=${v.size} vulnerable=${v.hits.length}`);
  for (const h of v.hits) console.log(`   ${h.severity} ${h.name}@${h.version}${h.optional ? ' (optional)' : ''} :: ${h.chain}`);
}
