#!/usr/bin/env node
// Runs the named test files through runNodeTests: a throwaway ALP_HOME and TMPDIR, without the
// caller's ALP session variables. A CI lane that lists its own files uses this instead of a bare
// `node --test` (t-bfbd). Builds nothing: the lane builds first.
//   node scripts/run-tests.mjs [--private-home] <file.test.js>...
// Direct node --test calls bypass this session isolation; CI and agent shells should use this entry.
// Files report their progress and time out after five minutes even with leaked handles.
// --private-home also removes ALP_*_BIN and gives the run a throwaway HOME/USERPROFILE.
import { runNodeTests } from './test-lib.mjs';

const args = process.argv.slice(2);
const files = args.filter(arg => arg !== '--private-home');
const unknown = files.filter(arg => arg.startsWith('-'));
if (unknown.length || !files.length) {
  console.error(`Usage: run-tests.mjs [--private-home] <file.test.js>...${unknown.length ? ` (unknown option ${unknown.join(', ')})` : ''}`);
  process.exit(2);
}
process.exitCode = runNodeTests(files, { privateHome: args.includes('--private-home') });
