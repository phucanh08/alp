// The portable entries must not reach Node: every module they import, followed through
// @anhlp/alp-protocol too, uses no Node built-in, no other package, and no process, Buffer or
// require. Bundles are inspected too (test/integration/client-sdk.test.js); this guard needs no
// bundler and fails at the import that broke it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
/** The protocol module the portable code may import, resolved through its package exports. */
const protocolEntry = fileURLToPath(import.meta.resolve('@anhlp/alp-protocol'));

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const NODE_GLOBALS = /\b(?:process\s*\.|Buffer\b|require\s*\(|__dirname|__filename|global\s*\.|setImmediate\b)/;

/** Code without comments, so prose that names Buffer or process does not count. @param {string} text */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

async function graph(entry) {
  const seen = new Map();
  const visit = async (file, from) => {
    if (seen.has(file)) return;
    const text = code(await readFile(file, 'utf8'));
    seen.set(file, text);
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) await visit(path.resolve(path.dirname(file), specifier), file);
      else if (specifier === '@anhlp/alp-protocol') await visit(protocolEntry, file);
      else assert.fail(`${path.relative(source, file)} imports ${specifier} (reached from ${from ? path.relative(source, from) : 'the entry'})`);
    }
  };
  await visit(entry);
  return seen;
}

for (const entry of ['portable.js', 'websocket.js']) {
  test(`${entry} reaches only portable modules`, async () => {
    const modules = await graph(path.join(source, entry));
    assert.ok(modules.size >= 3, 'the walk followed the imports');
    for (const [file, text] of modules) {
      const hit = NODE_GLOBALS.exec(text);
      assert.equal(hit, null, `${path.relative(source, file)} uses ${hit?.[0]}`);
    }
  });
}

test('the guard notices a Node import', async () => {
  const text = "import net from 'node:net';\nexport const x = 1;";
  const [match] = text.matchAll(IMPORT);
  assert.equal(match[1], 'node:net');
  assert.ok(NODE_GLOBALS.test(code('const size = Buffer.byteLength(s); // fine')));
  assert.equal(NODE_GLOBALS.test(code('/** Buffer and process are not used */ const a = 1;')), false);
});
