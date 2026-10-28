// `alp terminal allow|deny|status` (docs/protocol/alp-json-rpc-v1.md §12.10, issue #121 H): the host
// owner's switch is an owner-private file, states plainly what it grants, and never travels in a backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOME_UNITS } from '@anhlp/alp-core/backup';
import { terminalCommand, TERMINAL_WARNING } from '../src/terminal.js';

test('allow needs --yes after the warning; the file is private; deny keeps limits; status reads it', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-terminal-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const lines = [];
  const out = line => lines.push(line);
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  await terminalCommand(['allow'], { home, out });
  assert.equal(process.exitCode, 1);
  process.exitCode = exitCode;
  assert.match(lines.join('\n'), /NOT a sandbox/);
  assert.match(lines.join('\n'), /terminal\.exec/);
  await assert.rejects(lstat(path.join(home, 'terminal.json')), 'nothing written without --yes');
  await terminalCommand(['allow', '--yes'], { home, out });
  const file = path.join(home, 'terminal.json');
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, allowRemoteTerminal: true });
  lines.length = 0;
  await terminalCommand(['status', '--json'], { home, out });
  assert.equal(JSON.parse(lines[0]).allowRemoteTerminal, true);
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: true, limits: { maxPerPrincipal: 1 } }), { mode: 0o600 });
  await terminalCommand(['deny'], { home, out });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, allowRemoteTerminal: false, limits: { maxPerPrincipal: 1 } });
  // A group-readable file is reported, and counts as off.
  await terminalCommand(['allow', '--yes'], { home, out });
  await chmod(file, 0o644);
  lines.length = 0;
  await terminalCommand(['status', '--json'], { home, out });
  const status = JSON.parse(lines[0]);
  assert.equal(status.allowRemoteTerminal, false);
  assert.match(status.problem, /not a private file/);
  assert.match(TERMINAL_WARNING('someone'), /as someone/);
  // Paseo app devices need their own opt-in; deny --paseo takes only that back.
  await chmod(file, 0o600);
  await terminalCommand(['allow', '--yes'], { home, out });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).allowPaseoTerminal, undefined);
  await terminalCommand(['allow', '--paseo', '--yes'], { home, out });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).allowPaseoTerminal, true);
  await terminalCommand(['deny', '--paseo'], { home, out });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, allowRemoteTerminal: true, limits: { maxPerPrincipal: 1 } });
});

test('no backup carries the switch', () => {
  assert.ok(!HOME_UNITS.includes('terminal.json'));
});

test('corrupt terminal.json falls back to default off status without throwing SyntaxError', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-terminal-corrupt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'terminal.json');
  await writeFile(file, 'INVALID JSON { truncated: true', { mode: 0o600 });
  const lines = [];
  const out = line => lines.push(line);
  // Status must not throw SyntaxError and must report off
  await terminalCommand(['status', '--json'], { home, out });
  const status = JSON.parse(lines[0]);
  assert.equal(status.allowRemoteTerminal, false);
  assert.equal(status.allowPaseoTerminal, false);

  // allow --yes must overwrite corrupt file cleanly
  await terminalCommand(['allow', '--yes'], { home, out });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, allowRemoteTerminal: true });
});
