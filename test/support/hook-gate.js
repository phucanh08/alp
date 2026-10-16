// What the hook tests' POSIX gate does in sh, for Windows' cmd.exe: fails with "<name>: tests failed" until
// $ALP_PROJECT/out/ok-<name> exists. Usage: node hook-gate.js <name>
import { existsSync } from 'node:fs';

const [name] = process.argv.slice(2);
if (!existsSync(`${process.env.ALP_PROJECT}/out/ok-${name}`)) {
  console.error(`${name}: tests failed`);
  process.exit(1);
}
