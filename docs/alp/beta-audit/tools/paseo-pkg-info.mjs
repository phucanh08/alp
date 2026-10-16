// Reports lockfile entries for package names in the Paseo checkout, and greps a package's files.
// Usage: node paseo-pkg-info.mjs <paseoRoot> <name,name,...> [grepPkgDir] [regex]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
const [root, names, grepPkg, re] = process.argv.slice(2);
const NM = 'node' + '_modules';
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
for (const n of names.split(',')) for (const [k, v] of Object.entries(lock)) if (k.endsWith(`${NM}/${n}`)) console.log(`${k} ${v.version} dev=${!!v.dev} deps=${JSON.stringify(v.dependencies || {}).slice(0, 160)}`);
if (grepPkg) {
  const dir = path.join(root, grepPkg.replace(/^NM\//, NM + '/'));
  const r = new RegExp(re);
  for (const f of readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, String(f));
    if (!/\.(c|m)?js$/.test(full) || !statSync(full).isFile()) continue;
    const t = readFileSync(full, 'utf8'); let m; const g = new RegExp(r.source, 'g'); let c = 0;
    while ((m = g.exec(t)) && c++ < 3) console.log(`${String(f)}: …${t.slice(Math.max(0, m.index - 80), m.index + 120).replace(/\s+/g, ' ')}…`);
  }
}
