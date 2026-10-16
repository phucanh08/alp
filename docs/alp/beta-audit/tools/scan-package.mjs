// Greps an installed package (resolved from <repoRoot>) for a regex, printing file:line and text.
// Usage: node scan-package.mjs <repoRoot> <packageName> <regex> [subdirFilter]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [root, name, pattern, filter = ''] = process.argv.slice(2);
const dir = path.join(root, 'node' + '_modules', name);
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
console.log(`${name}@${pkg.version} (${dir})`);
const re = new RegExp(pattern);
for (const f of readdirSync(dir, { recursive: true })) {
  const file = String(f).replaceAll('\\', '/');
  if (!/\.(c|m)?js$/.test(file) || !file.includes(filter)) continue;
  const full = path.join(dir, file);
  if (!statSync(full).isFile()) continue;
  readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
    if (re.test(line)) console.log(`${file}:${i + 1}: ${line.trim().slice(0, 220)}`);
  });
}
