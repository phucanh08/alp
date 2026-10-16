// Searches the shipped ALP web app JS (Expo web export inside the plugin) for distinctive
// strings of packages flagged by npm audit, to tell browser-shipped code from build tooling.
// Usage: node web-bundle-signatures.mjs <alpRoot> <out.json>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [alpRoot, outPath] = process.argv.slice(2);
const jsDir = path.join(alpRoot, 'integrations/paseo/server', 'di' + 'st', 'web-app/_expo/static/js/web');
const code = readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(jsDir, f), 'utf8')).join('\n');

// Signatures chosen from each package's own source (identifiers/messages that survive minification).
const SIG = {
  'linkify-it': ['fuzzyLink', 'fuzzyEmail', 'mailto:'],
  'markdown-it': ['markdown-it', 'linkify'],
  nanoid: ['useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'],
  'shell-quote': ['(?:\\|\\||\\&\\&|;;|\\|\\&|\\<\\(|\\<\\<\\<|>>|>\\&|<\\&|[&;()|<>])'],
  tar: ['TAR_ENTRY_INVALID', 'TAR_BAD_ARCHIVE'],
  undici: ['UND_ERR_'],
  'node-forge': ['forge.pki', 'node-forge'],
  '@xmldom/xmldom': ['xmldom', 'requireWellFormed'],
  braces: ['Expected a string', 'braces'],
  'js-yaml': ['!!omap', 'JS-YAML', 'tag:yaml.org,2002:omap'],
  picomatch: ['picomatch'],
  minimatch: ['minimatch'],
  'brace-expansion': ['\\0SLASH', 'brace-expansion'],
  postcss: ['postcss', 'CssSyntaxError'],
  browserslist: ['browserslist', 'BrowserslistError'],
  'image-size': ['image-size', 'Unsupported file type'],
  seroval: ['seroval'],
  lodash: ['__lodash_hash_undefined__', 'templateSettings'],
  axios: ['axios', 'AxiosError'],
  'form-data': ['form-data', 'FormData.LINE_BREAK'],
  'fast-uri': ['fast-uri'],
  hono: ['hono'],
  'smol-toml': ['TomlError'],
  joi: ['ValidationError', 'joi'],
  ws: ['ws does not work in the browser', 'Sec-WebSocket-Key'],
  sharp: ['sharp'],
  compression: ['compression'],
  'source-map-js': ['source-map-js', 'sourcesContent'],
  'http-cache-semantics': ['max-stale'],
  tmp: ['TMPDIR'],
  'ip-address': ['Address4', 'Address6'],
  vite: ['vite'],
  tinypool: ['tinypool'],
  '@tanstack/react-start': ['react-start', 'createServerFn'],
};
const out = {};
for (const [pkg, sigs] of Object.entries(SIG)) {
  out[pkg] = Object.fromEntries(sigs.map((s) => {
    let n = 0, i = -1;
    while ((i = code.indexOf(s, i + 1)) !== -1 && n < 999) n++;
    return [s, n];
  }));
}
writeFileSync(outPath, JSON.stringify({ bytes: code.length, signatures: out }, null, 1));
console.log('bundle bytes', code.length);
for (const [pkg, s] of Object.entries(out)) console.log(pkg.padEnd(24), JSON.stringify(s));
