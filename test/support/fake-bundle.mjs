// A stand-in ALP bundle (scripts/build-bundle.mjs layout) for installer tests: alp-bundle.json, the
// real launcher, this Node as node/bin/node (a symlink) or node/node.exe (a copy), and a cli.js that
// prints `version` for --version and its arguments otherwise.
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { POSIX_LAUNCHER, WINDOWS_LAUNCHER } from '../../scripts/build-bundle.mjs';

/** Writes <directory>/alp-<version>-<platform>/ and returns its path. */
export async function fakeBundle(directory, version, platform) {
  const root = path.join(directory, `alp-${version}-${platform}`);
  const windows = platform.startsWith('windows-');
  const cli = path.join(root, 'lib/node_modules/@anhlp/alp-cli/dist/cli.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, `if (process.argv[2] === '--version') console.log(${JSON.stringify(version)}); else console.log(JSON.stringify(process.argv.slice(2)));\n`);
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, windows ? 'node' : 'node/bin'), { recursive: true });
  if (windows) {
    await writeFile(path.join(root, 'bin/alp.cmd'), WINDOWS_LAUNCHER);
    await copyFile(process.execPath, path.join(root, 'node/node.exe'));
  } else {
    await writeFile(path.join(root, 'bin/alp'), POSIX_LAUNCHER);
    await chmod(path.join(root, 'bin/alp'), 0o755);
    await symlink(process.execPath, path.join(root, 'node/bin/node'));
  }
  await writeFile(path.join(root, 'alp-bundle.json'), JSON.stringify({ name: 'alp', version, platform, node: process.versions.node }));
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) await writeFile(path.join(root, file), `${file} of the test bundle\n`);
  return root;
}
