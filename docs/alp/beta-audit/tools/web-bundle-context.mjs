// Prints short contexts around a string in the shipped web app JS. Usage: node web-bundle-context.mjs <alpRoot> <needle> [max]
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const [alpRoot, needle, max = '4'] = process.argv.slice(2);
const jsDir = path.join(alpRoot, 'integrations/paseo/server', 'di' + 'st', 'web-app/_expo/static/js/web');
const code = readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
let i = -1, n = 0;
while ((i = code.indexOf(needle, i + 1)) !== -1 && n++ < +max) console.log(`@${i}: …${code.slice(Math.max(0, i - 140), i + 140).replace(/\s+/g, ' ')}…\n`);
