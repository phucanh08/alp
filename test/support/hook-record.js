// What the hook tests' POSIX recorder does in sh, for Windows' cmd.exe: appends "<event> <agent> <task> <stdin>"
// to $ALP_PROJECT/out/<name>.log. Usage: node hook-record.js <name>
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';

const [name] = process.argv.slice(2);
const { ALP_PROJECT, ALP_EVENT, ALP_AGENT, ALP_TASK = '' } = process.env;
mkdirSync(`${ALP_PROJECT}/out`, { recursive: true });
appendFileSync(`${ALP_PROJECT}/out/${name}.log`, `${ALP_EVENT} ${ALP_AGENT} ${ALP_TASK} ${readFileSync(0, 'utf8')}`);
