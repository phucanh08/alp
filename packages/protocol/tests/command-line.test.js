// session.resumeCommand's command lines (docs/protocol/alp-json-rpc-v1.md §12.8): every argument must
// reach the program as it is. POSIX lines run through a real /bin/sh; Windows lines through a reference
// of what cmd.exe and then the C runtime do with a command line (cmd.exe is not on this host).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { commandLine, quotePosix, quoteWindows, resumeCommandOf } from '@anhlp/alp-protocol';

const HOSTILE = [
  'plain', 'with space', '  leading and trailing  ', '', "it's", "''", '"double"', 'a"b', 'back\\slash', 'trail\\', 'trail\\\\', 'C:\\Program Files\\alp\\',
  '\\"', '$(rm -rf ~)', '`id`', '$HOME', '${PATH}', 'a;b', 'a&b', 'a&&b', 'a|b', 'a||b', 'a>b', 'a<b', 'a>>b', '(sub)', '{brace}', '[glob]', '*', '?', '~', '~user',
  '#comment', '!', '!!', '^', '^^', '%PATH%', '%%', 'a,b', 'a=b', '=b', 'tab\u00a0nbsp', 'ünïcödé', '日本語', 'emoji 🙂', '-n', '--flag=x y', 'ses_ab.c:1',
];

/** What /bin/sh passes to the program for a command line: printf prints each argument NUL-terminated. */
function viaSh(line) {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${line}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

/**
 * cmd.exe's reading of an interactive command line, for a line without double-quote mode (every quote
 * in a quoted argument is ^-escaped, so cmd.exe never enters it): `^x` is x, and a bare metacharacter
 * would be interpreted (redirection, pipes, variables), which fails here.
 */
function viaCmd(line) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '^') { i++; assert.ok(i < line.length, `dangling ^ in ${line}`); out += line[i]; continue; }
    assert.ok(!'&|<>()%!"'.includes(ch), `bare cmd.exe metacharacter ${ch} in ${line}`);
    out += ch;
  }
  return out;
}

/** How the Microsoft C runtime (CommandLineToArgvW) splits a command line into argv. */
function msvcrtArgv(line) {
  const argv = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\') {
        let n = 0;
        while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') { arg += '\\'.repeat(Math.floor(n / 2)); if (n % 2) arg += '"'; else quoted = !quoted; }
        else { arg += '\\'.repeat(n); i--; }
        continue;
      }
      if (ch === '"') { if (quoted && line[i + 1] === '"') { arg += '"'; i++; } else quoted = !quoted; continue; }
      if (!quoted && (ch === ' ' || ch === '\t')) break;
      arg += ch;
    }
    argv.push(arg);
  }
  return argv;
}

test('POSIX: each hostile argument reaches the program unchanged through /bin/sh', () => {
  for (const arg of HOSTILE) assert.deepEqual(viaSh(quotePosix(arg)), [arg], `${JSON.stringify(arg)} as ${quotePosix(arg)}`);
  assert.deepEqual(viaSh(commandLine(HOSTILE, 'posix')), HOSTILE);
});

test('Windows: each hostile argument reaches the program unchanged through cmd.exe and the C runtime', () => {
  for (const arg of HOSTILE) assert.deepEqual(msvcrtArgv(viaCmd(quoteWindows(arg))), [arg], `${JSON.stringify(arg)} as ${quoteWindows(arg)}`);
  assert.deepEqual(msvcrtArgv(viaCmd(commandLine(HOSTILE, 'windows'))), HOSTILE);
});

test('arguments are left bare only when nothing in them is special', () => {
  assert.equal(quotePosix('ses_ab.c:1'), 'ses_ab.c:1');
  assert.equal(quoteWindows('ses_ab.c:1'), 'ses_ab.c:1');
  assert.equal(quotePosix('with space'), "'with space'");
  assert.equal(quotePosix("it's"), "'it'\\''s'");
  assert.equal(quoteWindows('with space'), '^"with^ space^"');
  assert.equal(quoteWindows('a"b'), '^"a\\^"b^"');
  assert.equal(quoteWindows('%PATH%&calc'), '^"^%PATH^%^&calc^"');
  assert.equal(quotePosix(''), "''");
  assert.equal(quoteWindows(''), '^"^"');
});

test('an argument with a control character is refused: a pasted line break would run early', () => {
  for (const arg of ['a\nb', 'a\rb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'tab\there']) {
    assert.throws(() => quotePosix(arg), /control characters/);
    assert.throws(() => quoteWindows(arg), /control characters/);
  }
  assert.throws(() => quotePosix(/** @type {any} */ (42)), /string/);
});

test('resumeCommandOf is the ALP CLI attach, never a native runtime command', () => {
  const command = resumeCommandOf('ses_0123456789abcdef', 'posix');
  assert.deepEqual(command, { argv: ['alp', 'attach', 'ses_0123456789abcdef'], posix: 'alp attach ses_0123456789abcdef', windows: 'alp attach ses_0123456789abcdef', display: 'alp attach ses_0123456789abcdef', platform: 'posix' });
  assert.equal(resumeCommandOf('ses_1', 'windows').display, 'alp attach ses_1');
  assert.equal(resumeCommandOf('ses_1', 'windows').platform, 'windows');
  // Every id session.create takes ([A-Za-z0-9_.:-]) stays bare on both.
  const odd = resumeCommandOf('A.b:c-d_9', 'posix');
  assert.equal(odd.posix, 'alp attach A.b:c-d_9');
  assert.equal(odd.windows, 'alp attach A.b:c-d_9');
});
