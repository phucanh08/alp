// Third-party code esbuild inlines into a bundle keeps its licence. Each bundle's metafile names the
// node_modules files it read; this writes, beside the bundles, the name, version and licence text of
// every package they came from (THIRD-PARTY-NOTICES.txt, named in each package's NOTICE).
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const normalize = file => file.replaceAll('\\', '/');
export const THIRD_PARTY_NOTICES = 'THIRD-PARTY-NOTICES.txt';

/** The installed package directory a bundle input (or esbuild's `// path` comment) belongs to; the last node_modules wins. */
export function packageDirectory(file) {
  return /^(.*node_modules\/(?:@[^/]+\/[^/]+|[^@/][^/]*))\//.exec(normalize(file))?.[1];
}

/** The package name of a directory from packageDirectory. */
export const packageName = directory => /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(directory)[1];

/** The heading a package's entry starts with; pack-check looks packages up by it. */
export const heading = (name, version, license) => `${name}@${version} (${license})`;

// Paseo's own packages ship without a licence file or field; they are Paseo's Apache-2.0 code.
const PASEO = { license: 'Apache-2.0', file: path.join(root, 'paseo-web/LICENSE') };

// https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt
const MIT = `MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const declared = pkg => typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map(item => item.type ?? item).join(' OR ');
const person = value => typeof value === 'string' ? value : [value?.name, value?.email && `<${value.email}>`].filter(Boolean).join(' ');

/** One package's notice: its licence file(s), else what its manifest declares; `directory` is absolute or relative to the repo. */
async function entry(directory) {
  const dir = path.resolve(root, directory);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const files = await readdir(dir);
  const paseo = pkg.name.startsWith('@getpaseo/') ? PASEO : undefined;
  const license = declared(pkg) ?? paseo?.license;
  const texts = [];
  for (const file of files.filter(file => /^(licen[cs]e|copying)([.-]|$)/i.test(file))) texts.push(await readFile(path.join(dir, file), 'utf8'));
  if (!texts.length && paseo && [undefined, PASEO.license].includes(declared(pkg))) texts.push(await readFile(paseo.file, 'utf8'));
  // A package that ships no licence file keeps its declared licence: the standard text, with the
  // author and repository its package.json names. Only MIT is known; any other stops the build.
  const missingText = !texts.length;
  if (missingText) {
    if (license !== 'MIT') throw new Error(`${pkg.name}@${pkg.version} (${dir}) ships no licence file and declares ${license}; add its text`);
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    texts.push([
      `The package ships no licence file; its package.json declares MIT${pkg.author ? `, the author ${person(pkg.author)}` : ''}${repository ? ` and the repository ${repository}` : ''}. The standard MIT text (SPDX):`,
      MIT,
    ].join('\n\n'));
  }
  // An Apache-2.0 package's NOTICE travels with it (Apache-2.0 §4(d)).
  for (const file of files.filter(file => /^notice([.-]|$)/i.test(file))) texts.push(await readFile(path.join(dir, file), 'utf8'));
  if (!license) throw new Error(`${pkg.name}@${pkg.version} (${dir}) is bundled but declares no licence`);
  return { name: pkg.name, version: pkg.version, license, missingText, texts: texts.map(text => text.replaceAll('\r\n', '\n').trim()) };
}

/**
 * Writes `file` with every package in `directories` (installed package directories); returns the
 * headings and the packages that ship no licence text.
 */
export async function writeNoticesFor(file, directories, label) {
  const loaded = await Promise.all([...new Set(directories)].map(entry));
  const unique = new Map(loaded.map(item => [`${item.name}@${item.version}`, item]));
  const entries = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const rule = '='.repeat(80);
  const body = entries.map(item => `${rule}\n${heading(item.name, item.version, item.license)}\n${rule}\n\n${item.texts.join('\n\n')}\n`);
  await writeFile(file, `Third-party software bundled in ${label}\n\nThe bundled files of this package include code from the packages below; each keeps\nits own licence, reproduced here.\n\n${body.join('\n')}`);
  return { headings: entries.map(item => heading(item.name, item.version, item.license)), missingText: entries.filter(item => item.missingText).map(item => `${item.name}@${item.version}`) };
}

/** Writes `file` with every third-party package any of the esbuild `metafiles` bundled. */
export async function writeThirdPartyNotices(file, metafiles, label) {
  const directories = [];
  for (const metafile of metafiles) for (const input of Object.keys(metafile?.inputs ?? {})) {
    const directory = packageDirectory(input);
    if (directory) directories.push(directory);
  }
  return writeNoticesFor(file, directories, label);
}
