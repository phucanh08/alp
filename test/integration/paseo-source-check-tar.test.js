// t-ffe4.2: scripts/paseo-source-check.mjs reads the packed plugin's package.json with `tar`.
// Release acceptance runs under `shell: bash`, where Windows puts Git's GNU tar
// (C:\Program Files\Git\usr\bin) ahead of the system's bsdtar on PATH, and GNU tar reads an
// archive path such as `D:\a\_temp\…\x.tgz` as a remote `host:file`. That failure was swallowed
// and surfaced as `Unexpected end of JSON input`. CI runs this file in the windows-daemon lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { packedManifest } from '../../scripts/paseo-source-check.mjs';

/** A gzipped ustar archive of `files` ({ name: content }), built without any tar binary. */
function tarball(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function packed(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-packed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'anhlp-alp-paseo-0.0.0.tgz');
  await writeFile(file, tarball(files));
  return file;
}

/** On Windows, PATH as Git Bash (`shell: bash`) has it: Git's usr/bin, with its GNU tar, first. */
function gitBashPath(t) {
  if (process.platform !== 'win32') return undefined;
  const gitUsrBin = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin');
  if (!existsSync(path.join(gitUsrBin, 'tar.exe'))) return undefined;
  const saved = process.env.PATH;
  process.env.PATH = `${gitUsrBin}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
  return gitUsrBin;
}

test('reads the packed package.json from an absolute tarball path, with Git Bash PATH order on Windows', async t => {
  const file = await packed(t, { 'package/package.json': JSON.stringify({ name: '@anhlp/alp-paseo', version: '0.0.0' }) });
  assert.ok(path.isAbsolute(file));
  const gitUsrBin = gitBashPath(t);
  if (process.platform === 'win32') {
    // GitHub's Windows runners have Git; without it this test would not reproduce the release lane.
    assert.ok(gitUsrBin || !process.env.CI, 'Git for Windows usr/bin\\tar.exe is missing on this CI runner');
    t.diagnostic(`archive ${file}; PATH starts with ${gitUsrBin ?? '(no Git usr/bin found)'}`);
  }
  assert.equal(packedManifest(file).name, '@anhlp/alp-paseo');
});

test('a tar failure reports tar\'s exit status and stderr, not a JSON parse error', async t => {
  const file = await packed(t, { 'package/README.md': 'no manifest here\n' });
  assert.throws(() => packedManifest(file), error => {
    assert.doesNotMatch(error.message, /Unexpected end of JSON input/);
    assert.match(error.message, /package\/package\.json (exited [1-9]\d*|printed no package\.json)/);
    // Every tar names the missing member in its stderr, which must reach the message.
    assert.match(error.message, /\n.*package\/package\.json/i);
    return true;
  });
});
