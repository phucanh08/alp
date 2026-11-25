import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { installPack } from '../../packages/core/src/library/templates/packs.js';
import { addAllowRule, commandDecision, parseRule, plainCommands, profileFor, simpleCommands, unwrapShell, validatePermissions } from '../../packages/core/src/permissions.js';
import { claudePermissions, createAlpRuntime, createCopy, reclaimCopies, removeCopy, resolveSession } from '../../dist/runtime/index.js';
import { teardown } from '../support/teardown.js';
import { setProfiles } from '../support/fake-agent.js';

const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));

/**
 * What a read-only Claude session is denied besides its profile's rules (t-cde5): the Paseo
 * credentials under ALP_HOME, as named and as resolved, and the /tmp directory of the token socket
 * of a home too long for a socket address, as rules and as sandbox read denials.
 */
function credentialDenials() {
  const home = path.resolve(process.env.ALP_HOME || path.join(homedir(), '.alp'));
  let real = home;
  try { real = realpathSync(home); } catch {}
  const homes = real === home ? [home] : [home, real];
  const tmp = process.platform === 'win32' ? '/tmp' : realpathSync('/tmp');
  const fallback = root => process.platform === 'win32' || Buffer.byteLength(path.join(root, 'paseo', 'token.sock')) < 100 ? []
    : [...new Set(['/tmp', tmp].map(dir => path.posix.join(dir, `alp-paseo-${process.getuid()}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`)))];
  const directories = [...new Set([...homes.map(root => path.join(root, 'paseo')), ...homes.flatMap(fallback)])];
  const files = homes.map(root => path.join(root, 'relay-keypair.json'));
  return { rules: [...directories.map(directory => `Read(/${directory}/**)`), ...files.map(file => `Read(/${file})`)], denyRead: [...directories, ...files] };
}

async function project(t, permissions, userPermissions) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-permissions-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  await initProject(root);
  await mkdir(home, { recursive: true });
  const settings = path.join(root, '.alp', 'settings.json');
  if (permissions) await writeFile(settings, JSON.stringify({ ...JSON.parse(await readFile(settings, 'utf8')), permissions }));
  if (userPermissions) await writeFile(path.join(home, 'settings.json'), JSON.stringify({ permissions: userPermissions }));
  return { directory, root, home };
}

test('rules use Claude Code syntax and settings are checked', () => {
  assert.deepEqual(parseRule('Bash'), { tool: 'Bash' });
  assert.deepEqual(parseRule('Bash(*)'), { tool: 'Bash' });
  assert.deepEqual(parseRule('Bash(npm test:*)'), { tool: 'Bash', specifier: 'npm test:*' });
  assert.deepEqual(parseRule('WebFetch(domain:example.com)'), { tool: 'WebFetch', specifier: 'domain:example.com' });
  assert.deepEqual(parseRule('mcp__github__search'), { tool: 'mcp__github__search' });
  assert.throws(() => parseRule('Bash()'), /empty specifier/);
  assert.throws(() => parseRule('npm test'), /is not Tool or Tool\(specifier\)/);
  assert.throws(() => parseRule('bash(npm test:*)'), /names unknown tool bash; use Bash, Read/);
  const check = value => () => validatePermissions(value, 'settings.json');
  assert.throws(check([]), /permissions must be an object/);
  assert.throws(check({ rules: {} }), /unsupported permissions field 'rules'/);
  assert.throws(check({ profiles: { r: { base: 'admin' } } }), /permissions\.profiles\.r\.base must be read-only, workspace-write, full-access/);
  assert.throws(check({ profiles: { r: { mode: 'x' } } }), /unsupported field 'mode'/);
  assert.throws(check({ profiles: { r: { beyondMode: 'maybe' } } }), /permissions\.profiles\.r\.beyondMode must be refuse or ask/);
  assert.throws(check({ profiles: { r: { allow: ['npm test'] } } }), /permissions\.profiles\.r\.allow: "npm test" is not Tool/);
  assert.throws(check({ agents: { reviewer: 3 } }), /permissions\.agents\.reviewer must name a profile/);
  assert.deepEqual(check({ profiles: { r: { base: 'read-only', allow: [' Bash(npm test:*) '] } }, agents: { reviewer: 'r' } })(),
    { profiles: { r: { base: 'read-only', allow: ['Bash(npm test:*)'], ask: [], deny: [] } }, agents: { reviewer: 'r' } });
});

test('a command is allowed only when allow rules cover every part of it, and denied when a deny rule covers any', () => {
  const profile = { allow: ['Bash(npm test:*)', 'Bash(git diff:*)', 'Bash(git status)'], deny: ['Bash(git push:*)', 'Bash(rm:*)'] };
  const cases = [
    ['npm test', 'allow'], ['npm test -- --watch=false', 'allow'], ['npm test 2>&1', 'allow'], ['npm test 2>/dev/null', 'allow'],
    ['git diff HEAD && git status', 'allow'], ['git status --short', undefined], ['npm testing', undefined],
    ['npm test > out.txt', undefined], ['npm test &> out.txt', undefined], ['git diff | tail -5', undefined],
    ['npm test; rm -rf dist', 'deny'], ['git push origin main', 'deny'], ['echo $(git push)', 'deny'], ['npm test "unclosed', 'deny'],
    ['echo "rm is fine in quotes"', undefined], ["/bin/zsh -lc 'npm test -- --x'", 'allow'], ["/bin/zsh -lc 'git diff; git push'", 'deny'],
  ];
  for (const [command, expected] of cases) assert.equal(commandDecision(profile, command), expected, command);
  assert.equal(commandDecision({ allow: ['Bash(npm test:*)'], deny: [] }, 'echo `id`'), undefined);
  assert.equal(commandDecision({ allow: [], deny: ['Bash'] }, 'ls'), 'deny');
  // Deny wins over ask, and ask over allow; `npm test *` is Claude's newer prefix form.
  const asking = { allow: ['Bash(git *)'], ask: ['Bash(git push *)'], deny: ['Bash(git push --force *)'] };
  assert.deepEqual(['git status', 'git', 'git push origin', 'git push --force origin', 'echo $(x)'].map(command => commandDecision(asking, command)), ['allow', 'allow', 'ask', 'deny', 'deny']);
  // A line ALP cannot split is asked about when there are ask rules and no deny rules.
  assert.equal(commandDecision({ allow: [], ask: ['Bash(git push *)'], deny: [] }, 'echo $(x)'), 'ask');
  assert.equal(unwrapShell(`/bin/bash -c 'echo '\\''hi'\\'''`), "echo 'hi'");
  // The quotes must enclose the rest of the line: a quoted word after `;` does not make it one script (t-cde5 review).
  for (const line of [`sh -c 'git log' ; touch /tmp/pwn 'b'`, `bash -c "git log" ; touch x "b"`, `sh -c 'a' 'b'`]) assert.equal(unwrapShell(line), line, line);
  // The shell's path is plain path characters, and only spaces or tabs separate its words: shell syntax before `sh`, or a
  // new line after it, is run by the shell, so such a line is no wrapper (t-cde5 review 5, reproduced on bash 3.2 and sh).
  for (const line of ["/bin/echo;touch${IFS}X;/bin/sh -c 'echo hi'", "/bin/echo;{touch,X};/bin/sh -c 'echo hi'", "/tmp/$(touch${IFS}X)/sh -c 'echo hi'",
    "/b`touch X`/sh -c 'echo hi'", "/b'in'/sh -c 'echo hi'", "/bin/sh\n-c 'echo hi'", "/bin/sh -c\n'echo hi'", "/bin/a&touch X&/bin/sh -c 'echo hi'"]) {
    assert.equal(unwrapShell(line), line, JSON.stringify(line));
    assert.notEqual(commandDecision({ allow: ['Bash(echo:*)'], deny: [] }, line), 'allow', JSON.stringify(line));
  }
  for (const wrapper of ['/bin/zsh -lc', '/usr/local/bin/bash -c', '/opt/homebrew/bin/zsh -lc', 'sh -c', '/bin/dash -c', "/bin/bash\t-lc"]) assert.equal(unwrapShell(`${wrapper} 'echo hi'`), 'echo hi', wrapper);
  // The line as given is checked as well as the script inside its wrapper: a wrapper never makes a line looser. A '\''
  // carries an unquoted backslash, so the line is not plain and is asked about, though its script `echo 'hi'` is.
  assert.equal(commandDecision({ allow: ['Bash(echo:*)'], deny: [] }, `/bin/bash -c 'echo '\\''hi'\\'''`), undefined);
  // A shell outside the system directories may be any program: an allow rule does not judge its script (review 6).
  for (const line of ["/tmp/x/sh -c 'echo hi'", "/bin/../bin/sh -c 'echo hi'", "/nix/store/x/bin/zsh -lc 'echo hi'"]) assert.equal(commandDecision({ allow: ['Bash(echo:*)'], deny: [] }, line), undefined, line);
  // Deny and ask rules still judge the script of any wrapper-looking line, as before (review 6: no deny regression).
  const guarded = { allow: ['Bash(git status:*)'], ask: ['Bash(git clone:*)'], deny: ['Bash(git push:*)'] };
  assert.equal(commandDecision(guarded, "/opt/a@1/bin/zsh -lc 'git push origin'"), 'deny');
  assert.equal(commandDecision(guarded, "/opt/a@1/bin/zsh -lc 'echo $(git push)'"), 'deny');
  assert.equal(commandDecision(guarded, "/opt/a@1/bin/zsh -lc 'git clone x'"), 'ask');
  assert.equal(commandDecision(guarded, "/opt/a@1/bin/zsh -lc 'git status'"), undefined);
  // T18 (vi): Codex runs the user's login shell (`/bin/zsh -lc '…'` on macOS). One from a Nix profile is outside the system
  // directories: a plain allow rule gives no decision (the mode refuses, or the user is asked), and no deny follows from it.
  for (const shell of ['/nix/var/nix/profiles/default/bin/zsh', '/run/current-system/sw/bin/zsh']) {
    assert.equal(commandDecision({ allow: ['Bash(git status:*)'], deny: [] }, `${shell} -lc 'git status'`), undefined, shell);
    assert.equal(commandDecision({ allow: ['Bash(git status:*)'], deny: ['Bash(git push:*)'] }, `${shell} -lc 'git status'`), undefined, shell);
    assert.equal(commandDecision({ allow: ['Bash(git status:*)'], ask: ['Bash(git status:*)'], deny: [] }, `${shell} -lc 'git status'`), 'ask', shell);
  }
  assert.equal(unwrapShell(`bash -c "echo \\"a\\" b"`), 'echo "a" b');
  // In double quotes the outer shell expands $(…) first: such a script is not unwrapped (t-cde5 re-review).
  assert.equal(unwrapShell(`sh -c "git log '$(id)'"`), `sh -c "git log '$(id)'"`);
  // A word-start `#` is a comment to the shell: no rule vouches for the line; a `#` inside a word is text.
  assert.equal(simpleCommands("git log # '\necho HIDDEN\n#'"), null);
  assert.equal(simpleCommands('git log # note'), null);
  assert.deepEqual(simpleCommands('echo a#b'), ['echo a#b']);
  assert.deepEqual(simpleCommands('a && b || c; d | e\nf & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

// t-cde5 g5 (the user's decision A'): a plain allow rule vouches only for a line of plain words; deny and checked rules are as before.
test('a plain allow rule covers only a line of plain words: what bash or zsh reads differently is asked about', () => {
  const echo = { allow: ['Bash(echo:*)'], deny: [] };
  // The two HIGHs of security review 4 on 2a36f6ce: bash and zsh run `touch X`; ALP read one echo.
  for (const line of [String.raw`echo $'\'' ; touch X ; echo '\'`, "echo ${x:='a[$(touch X)]'} $[x]"]) {
    assert.deepEqual(simpleCommands(line)?.length, 1, line);
    assert.equal(plainCommands(line), null, line);
    assert.equal(commandDecision(echo, line), undefined, line);
  }
  // The earlier ones, and the rest of what a shell expands or runs: never vouched for by a plain rule.
  for (const line of ['echo =(touch X)', 'echo *(e:touch X:)', 'echo $(touch X)', 'echo `touch X`', 'echo <(touch X)', 'echo $HOME', 'echo "$HOME"', 'echo ${HOME}', 'echo $[1+1]', 'echo $"x"',
    "echo a # '\ntouch X\n#'", 'echo a\0b', 'echo a\rb', 'echo a & touch X', 'echo a |& touch X', 'echo a\\;touch X', 'echo !!', 'echo "a!b"', 'echo "a\\"b"', 'echo "a`b`"', 'cat <<EOF', 'echo a > out', 'echo a >> out',
    'echo a &> out', 'echo a 2> err', 'echo a >/dev/nullx', 'echo ~/x', 'echo =ls', 'echo a*', 'echo a?', 'echo [ab]', 'echo {a,b}', 'echo a b', 'echo ‘a’', 'echo (a)', 'echo a; (touch X)', 'echo "unclosed', "echo 'unclosed"]) {
    assert.equal(plainCommands(line), null, JSON.stringify(line));
    assert.notEqual(commandDecision(echo, line), 'allow', JSON.stringify(line));
  }
  // Codex wraps a command in /bin/zsh -lc '…': the script inside is judged.
  assert.equal(commandDecision(echo, String.raw`/bin/zsh -lc "echo \$'x'"`), undefined);
  assert.equal(commandDecision(echo, `/bin/zsh -lc 'echo \${x}'`), undefined);
  // Quoted text is plain whatever it holds in single quotes, and in double quotes without $ ` \ !.
  const quoted = `echo 'a$b \`c\` "d" (e) #f' "g (h) #i 'j' Sửa" HEAD~1 HEAD^ --x=y:z,w@v%u+t >/dev/null 2>&1`;
  assert.deepEqual(plainCommands(`${quoted}\ngit status && npm test || true; a | b`), [quoted, 'git status', 'npm test', 'true', 'a', 'b']);
  // A redirect is plain only as a whole word: `a2>&1` is not one.
  assert.equal(plainCommands('echo a2>&1'), null);
});

test('the plain-word allow table: common commands that stay allowed, and those that now ask (t-cde5 g5)', () => {
  const profile = {
    allow: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(npm test:*)', 'Bash(node scripts/test.mjs:*)', 'Bash(node --test:*)',
      'Bash(cd:*)', 'Bash(find:*)', 'Bash(grep:*)', 'Bash(tail:*)', 'Bash(echo:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(git commit:*)'],
    deny: ['Bash(git push:*)'],
  };
  const allowed = ['git diff', 'git diff --stat', 'git diff HEAD~1 -- src/a.js', 'git diff origin/main...HEAD', 'git log --oneline -3', 'git log --format=%h%x09%s -5', 'git log v1..v2',
    'git show --stat HEAD', 'git show HEAD^', 'git show HEAD:packages/core/src/permissions.js', 'git status --short', 'npm test', 'npm test 2>&1 | tail -20', 'npm test >/dev/null 2>&1',
    'npm test > /dev/null', 'cd pkg && npm test', 'node scripts/test.mjs unit', 'node scripts/test.mjs unit 2>&1', 'node --test test/x.test.js', "find . -name '*.js'", "grep -rn 'a|b' src",
    'grep -rn "createServer(" src', 'echo "(a)"', "git commit -m 'fix: a $b'", 'git commit -m "Sửa lỗi"', 'git status\nnpm test', "/bin/zsh -lc 'git status'", '/bin/zsh -lc "npm test 2>&1"',
    "/bin/bash -lc 'cd pkg && npm test'", `/bin/zsh -lc 'git log --oneline -3 | tail -1'`];
  for (const command of allowed) assert.equal(commandDecision(profile, command), 'allow', JSON.stringify(command));
  // Allowed before g5, asked about now: a variable, an unquoted glob, a home path, braces, brackets, a comment,
  // a $ ` \ or ! in double quotes, a backslash, a word-start =.
  const asked = ['echo $HOME', 'npm test -- --grep $NAME', 'ls *.js', 'cat src/*.ts', 'cat ~/notes.txt', 'echo a.{js,map}', 'git diff HEAD@{1}', 'ls [ab].js', 'echo "cost $5"',
    'git commit -m "fix: \\"x\\""', 'echo a\\ b', 'echo =x', "/bin/zsh -lc 'echo $HOME'", 'git log --grep="a$"'];
  for (const command of asked) assert.equal(commandDecision(profile, command), undefined, JSON.stringify(command));
  // Deny rules match as before, plain line or not; a line ALP cannot split is refused when the profile has deny rules.
  assert.equal(commandDecision(profile, 'npm test; git push'), 'deny');
  assert.equal(commandDecision(profile, 'echo $HOME; git push origin'), 'deny');
  assert.equal(commandDecision(profile, 'echo $(git push)'), 'deny');
  // A rule with no specifier is a plain rule too.
  assert.equal(commandDecision({ allow: ['Bash'], deny: [] }, 'ls'), 'allow');
  assert.equal(commandDecision({ allow: ['Bash'], deny: [] }, String.raw`echo $'\'' ; touch X ; echo '\'`), undefined);
  // An ask rule asks as before, for a plain line or not.
  assert.equal(commandDecision({ allow: ['Bash(git:*)'], ask: ['Bash(git push:*)'], deny: [] }, 'git push $REMOTE'), 'ask');
});

test('profiles merge the project and the user, cap modes, and keep advisors read-only', async t => {
  const { root, home } = await project(t,
    { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'] }, builder: { base: 'workspace-write', deny: ['Bash(git push:*)'] } }, agents: { reviewer: 'review', peer: 'builder', main: 'builder' } },
    { profiles: { review: { base: 'full-access', allow: ['Bash(node --test:*)'], deny: ['Bash(rm:*)'] } }, agents: { reviewer: 'other', lead: 'workspace-write' } });
  const none = { ask: [], beyondMode: 'refuse' };
  assert.deepEqual(await profileFor(root, home, 'reviewer'), { name: 'review', base: 'read-only', allow: ['Bash(npm test:*)', 'Bash(node --test:*)'], deny: ['Bash(rm:*)'], ...none });
  assert.deepEqual(await profileFor(root, home, 'oracle'), { name: 'read-only', base: 'read-only', allow: [], deny: [], ...none });
  assert.deepEqual(await profileFor(root, home, 'lead'), { name: 'workspace-write', base: 'workspace-write', allow: [], deny: [], ...none });
  assert.equal(await profileFor(root, undefined, 'lead'), null);

  // A profile caps the mode a session asks for.
  assert.deepEqual(await resolved(root, home, { agent: 'peer', mode: 'full-access' }), ['workspace-write', 'builder']);
  assert.deepEqual(await resolved(root, home, { agent: 'main' }), ['workspace-write', 'builder']);
  assert.deepEqual(await resolved(root, home, { agent: 'reviewer', mode: 'full-access' }), ['read-only', 'review']);

  const { root: other } = await project(t, { profiles: { open: { base: 'workspace-write' } }, agents: { reviewer: 'open', peer: 'missing' } });
  await assert.rejects(profileFor(other, undefined, 'reviewer'), /reviewer is an advisor; its profile 'open' must have base read-only/);
  await assert.rejects(profileFor(other, undefined, 'peer'), /permissions\.agents\.peer names profile 'missing', which no settings file defines/);
});

async function resolved(root, home, spec) {
  const session = await resolveSession({ cwd: root, ...spec, ...(spec.agent === 'oracle' ? { model: 'claude:claude-fable-5-1' } : {}) }, { library: home });
  return [session.mode, session.permissions?.name];
}

test('Claude enforces deny rules and non-Bash allow rules itself; ALP decides Bash allow rules in canUseTool', () => {
  // A Bash allow rule handed to Claude would be matched as written and skip canUseTool (t-6dc5 G5-B).
  const options = claudePermissions('read-only', () => 'read-only', { allow: ['Bash(npm test:*)', 'Bash', 'WebFetch(domain:github.com)'], deny: ['Bash(git push:*)'] });
  assert.deepEqual(options.allowedTools, ['WebFetch(domain:github.com)']);
  // The user's deny rule, then (a read-only session, t-cde5) the denials of the Paseo credentials.
  assert.deepEqual(options.disallowedTools.slice(-1 - credentialDenials().rules.length), ['Bash(git push:*)', ...credentialDenials().rules]);
  assert.ok(options.disallowedTools.includes('Agent'));
  assert.equal(claudePermissions('read-only', () => 'read-only', { allow: ['Bash(npm test:*)'], deny: [] }).allowedTools, undefined);
  assert.equal(claudePermissions('full-access', () => 'full-access', null).allowedTools, undefined);
});

test('the path hardening leaves plain allowed commands allowed, and stops x/.. from leaving a path rule', () => {
  // Profiles that allow these today (the docs' review profile, and rules a reviewer is commonly given).
  const review = { allow: ['Bash(npm test:*)', 'Bash(node --test:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(node scripts/test.mjs:*)', 'Bash(./gradlew test:*)'], ask: ['Bash(npm install *)'], deny: ['Bash(rm:*)', 'Bash(git push:*)'] };
  for (const command of ['npm test', 'node --test packages/core/tests/research-pack.test.js', 'git diff', 'git diff HEAD~1 -- src/a.js', 'git diff origin/main...HEAD', 'git log --oneline -5', 'git log v1..v2', 'git show HEAD:packages/core/src/permissions.js',
    'node scripts/test.mjs unit', 'node scripts/test.mjs unit 2>&1', './gradlew test --info', 'git diff && npm test']) assert.equal(commandDecision(review, command), 'allow', command);
  assert.equal(commandDecision(review, 'npm install left-pad'), 'ask');
  assert.equal(commandDecision(review, 'git push'), 'deny');
  // A rule that names a path covers only paths in normal form.
  const scoped = { allow: ['Bash(cat /srv/data/*)', 'Bash(node scripts/test.mjs:*)'], deny: [] };
  assert.equal(commandDecision(scoped, 'cat /srv/data/a.txt'), 'allow');
  for (const command of ['cat /srv/data/../../etc/passwd', 'cat /srv/data//x', 'cat /srv/data/./x', 'node scripts/test.mjs ../../x', 'node scripts/test.mjs ~/x', 'node scripts/test.mjs --out=../x']) assert.equal(commandDecision(scoped, command), undefined, command);
});

// t-6dc5 G5-B round 2: the librarian profile the research pack installs, fed to Claude's canUseTool as a session gets it.
test('the installed librarian profile, through canUseTool: reads below its per-user root, never an abbreviated or path option', { skip: process.platform === 'win32' }, async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-librarian-gate-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'library');
  await initProject(root);
  await installPack('research', { scope: 'library', library });
  const installed = await profileFor(root, library, 'librarian', { readOnly: true });
  assert.ok(installed.allow.includes('Bash(@git-read /tmp/alp-librarian)'));
  // The shipped root /tmp/alp-librarian is shared by every local user: a scratch root takes its place here.
  const cache = path.join(directory, 'alp-librarian');
  const profile = { ...installed, allow: installed.allow.map(rule => rule.replace('/tmp/alp-librarian', cache)) };
  const gate = claudePermissions('read-only', () => 'read-only', { ...profile, floor: 'read-only', floorRoot: root });
  const bash = (command, leave = false) => gate.canUseTool('Bash', { command, ...(leave ? { dangerouslyDisableSandbox: true } : {}) }).then(result => result.behavior);
  // Its job: clone a public repository (which makes the root 0700), then read it, outside the sandbox.
  assert.equal(await bash(`git clone --depth 50 https://github.com/a/b ${cache}/a-b`, true), 'allow');
  assert.equal((await stat(cache)).mode & 0o777, 0o700);
  for (const args of ['fetch --depth 50', 'log --oneline -n 20', 'log -p -S createServer -- src', 'grep -n -i -e foo -C 3 -- lib', 'blame -L 10,20 src/a.js', 'show HEAD:src/a.js', 'rev-parse HEAD']) {
    assert.equal(await bash(`git -C ${cache}/a-b ${args}`, true), 'allow', args);
  }
  // What the security review ran through real git: refused (asked, with no one to ask here).
  for (const args of ["grep --open-f='touch /tmp/pwn #' hi", "grep --open='sh -c id' hi", 'grep -iOtouch hi', 'grep -nOtouch hi', 'grep --file=/etc/passwd', 'blame --contents=/etc/passwd a.js', 'blame --ignore-revs-file=/etc/passwd a.js', 'ls-files --exclude-from=/etc/passwd']) {
    assert.equal(commandDecision(profile, `git -C ${cache}/a-b ${args}`), 'ask', args);
    // The librarian's profile is read-only, so a command its checked rules do not cover never leaves the
    // sandbox (t-cde5 g2/g4): it runs as the sandboxed command it is (no network, no writes, no credentials).
    const decided = await gate.canUseTool('Bash', { command: `git -C ${cache}/a-b ${args}`, dangerouslyDisableSandbox: true });
    assert.notEqual(decided.updatedInput?.dangerouslyDisableSandbox, true, args);
  }
  // A path outside the (scratch) root is not this profile's, and a deny rule holds in the sandbox as well.
  // A clone outside the (scratch) root is not this profile's: it does not leave the sandbox, so it has no network.
  const outside = await gate.canUseTool('Bash', { command: 'git clone https://github.com/a/b /tmp/alp-librarian/a-b', dangerouslyDisableSandbox: true });
  assert.notEqual(outside.updatedInput?.dangerouslyDisableSandbox, true);
  // A shell wrapper around a covered command, followed by anything, never leaves (t-cde5 review: greedy sh -c).
  for (const command of [`sh -c 'git clone https://github.com/a/b ${cache}/a-b' ; touch ${directory}/pwned 'b'`, `bash -c "git -C ${cache}/a-b log --author=a" ; touch ${directory}/pwned "b"`, `sh -c 'git -C ${cache}/a-b log'`, `git -C ${cache}/a-b log # '\ntouch ${directory}/pwned\n#'`]) {
    // The compound ones are not covered at all; a lone wrapped command is (Codex wraps commands so), but it still never leaves.
    if (command.includes(';') || command.includes('#')) assert.notEqual(commandDecision(profile, command), 'allow', command);
    const wrapped = await gate.canUseTool('Bash', { command, dangerouslyDisableSandbox: true });
    assert.notEqual(wrapped.updatedInput?.dangerouslyDisableSandbox, true, command);
  }
  // The checked clone itself leaves (it needs the network).
  const inRoot = await gate.canUseTool('Bash', { command: `git clone --depth 1 https://github.com/a/c ${cache}/a-c`, dangerouslyDisableSandbox: true });
  assert.equal(inRoot.updatedInput?.dangerouslyDisableSandbox, true);
  assert.equal(await bash('g\\it push $X'), 'deny');
});

test('Codex asks ALP before leaving its sandbox, and ALP answers by the profile', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, {
    profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] }, lead: { deny: ['Bash(git push:*)'] }, builder: { base: 'workspace-write' } },
    agents: { reviewer: 'review', main: 'lead', peer: 'builder' },
  });
  const runtimes = [];
  // Its reviewer and peer run on Codex too: a target's profiles are the models it takes.
  await setProfiles(root, { reviewer: ['codex:gpt-6.1-sol'], peer: ['codex:gpt-6.1-sol'] });
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  // Full access with deny rules: Codex asks before every command.
  // Codex has a permissions field of its own; the profile stays in ALP.
  assert.deepEqual([main.config.approvalPolicy, main.config.sandbox, main.config.permissions], ['untrusted', 'danger-full-access', undefined]);
  assert.match(main.config.developerInstructions, /Permissions: profile lead, mode full-access\. Never: Bash\(git push:\*\)\./);
  // Main briefs its targets knowing their profiles; oracle's plain read-only one says nothing new.
  assert.match(main.config.developerInstructions, /Permission profiles of your targets[^\n]*: peer: at most workspace-write; reviewer: at most read-only, may also run Bash\(npm test:\*\), never Bash\(rm:\*\)\./);
  assert.doesNotMatch(main.config.developerInstructions, /oracle: at most/);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review it' }] });
  assert.equal(main.started[0].params.approvalPolicy, 'untrusted');
  const ask = (harness, command) => harness.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: harness.threadId, command });
  assert.deepEqual(await ask(main, "/bin/zsh -lc 'git push origin main'"), { decision: 'decline' });
  assert.deepEqual(await ask(main, "/bin/zsh -lc 'npm install'"), { decision: 'accept' });

  // A read-only reviewer with allow rules: commands run sandboxed, and only allowed ones leave the sandbox.
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Run the tests', model: 'codex:gpt-6.1-sol', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const reviewer = runtimes[2];
  assert.deepEqual([reviewer.config.approvalPolicy, reviewer.config.sandbox, reviewer.started[0].params.approvalPolicy], ['on-request', 'read-only', 'on-request']);
  assert.match(reviewer.config.developerInstructions, /Beyond your mode you may also use: Bash\(npm test:\*\)\. Never: Bash\(rm:\*\)\.[\s\S]*with escalated permissions from the start/);
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'npm test 2>&1'"), { decision: 'accept' });
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'npm test && rm -rf dist'"), { decision: 'decline' });
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'touch x'"), { decision: 'decline' });
  // zsh runs what `=(…)` and a glob qualifier `*(e…)` name: an allow rule never covers an unquoted `(` (t-cde5 review).
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'npm test =(touch x)'"), { decision: 'decline' });
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'npm test *(e.touch x.)'"), { decision: 'decline' });
  // A line that is not plain words gets nothing from an allow rule (t-cde5 g5): zsh would run `touch X` here too.
  assert.deepEqual(await ask(reviewer, String.raw`/bin/zsh -lc "npm test \$'\\'' ; touch X ; echo '\\'"`), { decision: 'decline' });
  assert.deepEqual(await reviewer.serverRequest('item/fileChange/requestApproval', { threadId: reviewer.threadId }), { decision: 'decline' });
  await assert.rejects(reviewer.serverRequest('item/permissions/requestApproval', {}), /Unsupported runtime request/);
  reviewer.call('alp_handoff', { outcome: 'complete', summary: 'Tests pass' });
  reviewer.finish('Reviewed');
  await main.call('alp_wait', {});

  // A peer's profile caps the mode main asks for; a worktree is still a writer.
  const started = await main.call('alp_delegate', { agent: 'peer', task: 'Fix it', model: 'codex:gpt-6.1-sol', mode: 'full-access', wait: false });
  assert.deepEqual([started.mode, started.modeNote], ['workspace-write', 'peer runs workspace-write: its permission profile builder caps it']);
  await until(() => runtimes.length === 4 && runtimes[3].started.length === 1);
  assert.deepEqual([runtimes[3].config.sandbox, runtimes[3].config.approvalPolicy], ['workspace-write', 'never']);
  runtimes[3].call('alp_handoff', { outcome: 'complete', summary: 'Fixed' });
  runtimes[3].finish('Fixed');
  await main.call('alp_wait', {});
  main.finish('Done');

  const read = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'permission');
  await until(async () => (await read()).length === 9);
  assert.deepEqual((await read()).map(entry => [entry.agent, entry.request, entry.decision, entry.rule ?? null]), [
    ['main', 'command', 'decline', 'deny'], ['main', 'command', 'accept', null],
    ['reviewer', 'command', 'accept', 'allow'], ['reviewer', 'command', 'decline', 'deny'], ['reviewer', 'command', 'decline', null],
    // The two zsh lines: ALP cannot split them and the profile has deny rules, so they are refused as deny.
    ['reviewer', 'command', 'decline', 'deny'], ['reviewer', 'command', 'decline', 'deny'],
    // The $'…' line splits, no deny rule covers it, and it is not plain: no rule decides, and read-only refuses it.
    ['reviewer', 'command', 'decline', null], ['reviewer', 'file change', 'decline', null],
  ]);
});

test('without permission settings Codex never asks, as before', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  assert.deepEqual([main.config.approvalPolicy, supervisor.config.approvalPolicy], ['never', 'never']);
  assert.doesNotMatch(main.config.developerInstructions, /Permissions:|Permission profiles of your targets/);
  // Main cannot make an advisor write.
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', mode: 'full-access', wait: false });
  await until(() => runtimes.length === 3);
  assert.equal(runtimes[2].config.sandbox, 'read-only');
});

test('a Claude session carries its profile to the transport', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'] } }, agents: { reviewer: 'review' } });
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  assert.deepEqual([main.config.runtime, main.config.permissions, supervisor.config.permissions], ['claude', null, { name: 'read-only', base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse' }]);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', model: 'claude:claude-opus-5-5', wait: false });
  await until(() => runtimes.length === 3);
  assert.deepEqual(runtimes[2].config.permissions, { name: 'review', base: 'read-only', allow: ['Bash(npm test:*)'], ask: [], deny: [], beyondMode: 'refuse' });
});

test('Claude asks ALP for ask rules and for what a read-only mode refuses', async () => {
  const asked = [];
  const answer = { allow: true, always: true };
  const { canUseTool, settings } = claudePermissions('read-only', () => 'read-only', { allow: [], ask: ['Bash(git push *)'], deny: [], beyondMode: 'ask' }, async request => { asked.push(request); return answer; });
  assert.deepEqual(settings, { permissions: { ask: ['Bash(git push *)'] } });
  // An ask rule: Claude says so in decisionReasonType; no rule to add.
  assert.deepEqual(await canUseTool('Bash', { command: 'git push' }, { decisionReasonType: 'rule' }), { behavior: 'allow', updatedInput: { command: 'git push' } });
  // Beyond the mode: Claude's suggestion becomes the rule an always-allow adds for the session.
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm ci *' }], behavior: 'allow', destination: 'localSettings' }];
  assert.deepEqual(await canUseTool('Bash', { command: 'npm ci' }, { decisionReasonType: 'other', suggestions }),
    { behavior: 'allow', updatedInput: { command: 'npm ci' }, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm ci *' }], behavior: 'allow', destination: 'session' }] });
  assert.deepEqual(await canUseTool('Edit', { file_path: 'a.js' }, {}), { behavior: 'allow', updatedInput: { file_path: 'a.js' }, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: 'a.js' }], behavior: 'allow', destination: 'session' }] });
  assert.deepEqual(asked.map(request => [request.reason, request.rule ?? null]), [['rule', null], ['mode', 'Bash(npm ci *)'], ['mode', 'Edit(a.js)']]);
  answer.allow = false; answer.message = 'The user refused it';
  assert.deepEqual(await canUseTool('Bash', { command: 'rm x' }, {}), { behavior: 'deny', message: 'The user refused it' });
  assert.equal((await canUseTool('Read', { file_path: 'a.js' }, {})).behavior, 'allow');
  // Without beyondMode ask, read-only refuses as before and asks no one.
  const refusing = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [], beyondMode: 'refuse' }, async () => assert.fail('asked'));
  assert.deepEqual(await refusing.canUseTool('Bash', { command: 'npm ci' }, {}), { behavior: 'deny', message: 'ALP session is read-only' });
  assert.equal(refusing.settings, undefined);
});

test('the user answers permission questions; always allow writes the rule and stops asking', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, {
    profiles: { review: { base: 'read-only', ask: ['Bash(git push *)'], beyondMode: 'ask' } },
    agents: { reviewer: 'review' },
  });
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  assert.match(main.config.developerInstructions, /reviewer: at most read-only, with the user's approval each time Bash\(git push \*\), and asks the user before anything else beyond that mode\./);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const reviewer = runtimes[2];
  assert.equal(reviewer.config.approvalPolicy, 'on-request');
  assert.match(reviewer.config.developerInstructions, /The user approves each use of: Bash\(git push \*\); ALP asks them and you wait\. ALP asks the user before anything else your mode does not allow/);
  const ask = (command, extra = {}) => reviewer.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: reviewer.threadId, command, ...extra });
  const question = async () => { await until(() => runtime.questions().length === 1); return runtime.questions()[0]; };

  // Beyond the mode: the user may allow always, and the rule lands in the project's settings.
  const install = ask("/bin/zsh -lc 'npm install --no-audit'", { proposedExecpolicyAmendment: ['npm', 'install'], reason: 'needs network' });
  const first = await question();
  assert.deepEqual(first.options, ['Allow once', 'Always allow', 'Deny']);
  assert.match(first.body, /^reviewer wants to run `npm install --no-audit` \(needs network\)\. Its read-only mode does not allow that\. Always allow adds Bash\(npm install \*\) to profile review\.$/);
  runtime.answer(first.id, { text: 'Always allow' });
  assert.deepEqual(await install, { decision: 'accept' });
  const settings = JSON.parse(await readFile(path.join(root, '.alp', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.profiles.review.allow, ['Bash(npm install *)']);
  assert.equal(settings.workflow !== undefined || settings.permissions !== undefined, true);
  // The same session no longer asks about it.
  assert.deepEqual(await ask("/bin/zsh -lc 'npm install left-pad'"), { decision: 'accept' });
  assert.deepEqual(runtime.questions(), []);

  // An ask rule asks every time, with no always.
  const push = ask("/bin/zsh -lc 'git push origin main'");
  const second = await question();
  assert.deepEqual(second.options, ['Allow once', 'Deny']);
  assert.match(second.body, /Its permission profile review asks you each time\.$/);
  runtime.answer(second.id, { text: 'Deny' });
  assert.deepEqual(await push, { decision: 'decline' });

  // Questions wait in turn; another answer refuses.
  const one = ask("/bin/zsh -lc 'touch a'");
  const two = ask("/bin/zsh -lc 'touch b'");
  const third = await question();
  runtime.answer(third.id, { text: 'Allow once' });
  assert.deepEqual(await one, { decision: 'accept' });
  const fourth = await question();
  assert.match(fourth.body, /touch b/);
  runtime.answer(fourth.id, { text: 'not now' });
  assert.deepEqual(await two, { decision: 'decline' });

  // Claude's requests go the same way.
  const claude = reviewer.serverRequest('item/permission/request', { tool: 'Bash', input: { command: 'npm ci' }, reason: 'mode', rule: 'Bash(npm ci *)' });
  runtime.answer((await question()).id, { text: 'Allow once' });
  assert.deepEqual(await claude, { allow: true });

  // The run log is written in the background.
  const permissions = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'permission');
  await until(async () => (await permissions()).length === 6);
  assert.deepEqual((await permissions()).map(entry => [entry.decision, entry.asked ?? false, entry.always ?? null, entry.rule ?? null]), [
    ['accept', true, 'Bash(npm install *)', null], ['accept', false, null, 'allow'], ['decline', true, null, 'ask'],
    ['accept', true, null, null], ['decline', true, null, null], ['accept', true, null, null],
  ]);
  reviewer.call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  reviewer.finish('Done');
  await main.call('alp_wait', {});
  main.finish('Done');
});

// #116: the user writing in the chat ends main's own alp_ask, never a permission prompt.
test('a permission prompt keeps waiting for the user\'s decision when the user writes in the chat', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, { profiles: { guard: { ask: ['Bash(git push *)'] } }, agents: { main: 'guard' } });
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Ship it' }] });
  const push = main.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: main.threadId, command: "/bin/zsh -lc 'git push origin main'" });
  await until(() => runtime.questions().length === 1);
  const [question] = runtime.questions();
  await runtime.prompt('root', { clientMessageId: 'steer', delivery: 'steer', content: [{ type: 'text', text: 'Sao rồi e' }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(runtime.questions().map(q => q.id), [question.id], 'the permission prompt is still open');
  runtime.answer(question.id, { text: 'Allow once' });
  assert.deepEqual(await push, { decision: 'accept' });
});

test('by default ALP asks permission questions in Vietnamese and takes Vietnamese answers (ALPD §54)', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, {
    profiles: { review: { base: 'read-only', ask: ['Bash(git push *)'], beyondMode: 'ask' } },
    agents: { reviewer: 'review' },
  });
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await runtimes[0].call('alp_delegate', { agent: 'reviewer', task: 'Review', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const reviewer = runtimes[2];
  const ask = (command, extra = {}) => reviewer.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: reviewer.threadId, command, ...extra });
  const question = async () => { await until(() => runtime.questions().length === 1); return runtime.questions()[0]; };

  const install = ask("/bin/zsh -lc 'npm install --no-audit'", { proposedExecpolicyAmendment: ['npm', 'install'] });
  const first = await question();
  assert.deepEqual(first.options, ['Cho phép lần này', 'Luôn cho phép', 'Từ chối']);
  assert.equal(first.body, 'reviewer muốn chạy `npm install --no-audit`. Chế độ read-only của nó không cho phép việc này. Luôn cho phép sẽ thêm Bash(npm install *) vào hồ sơ review.');
  runtime.answer(first.id, { text: 'Cho phép lần này' });
  assert.deepEqual(await install, { decision: 'accept' });
  // An English answer still counts.
  const push = ask("/bin/zsh -lc 'git push origin main'");
  const second = await question();
  assert.deepEqual(second.options, ['Cho phép lần này', 'Từ chối']);
  assert.match(second.body, /Hồ sơ quyền review của nó yêu cầu hỏi bạn mỗi lần\.$/);
  runtime.answer(second.id, { text: 'Allow once' });
  assert.deepEqual(await push, { decision: 'accept' });
  const touch = ask("/bin/zsh -lc 'touch a'");
  runtime.answer((await question()).id, { text: 'Từ chối' });
  assert.deepEqual(await touch, { decision: 'decline' });
});

test('always allow writes to the file that defines the profile', async t => {
  const { root, home } = await project(t, undefined, { profiles: { mine: { base: 'read-only' } } });
  assert.equal(await addAllowRule(root, home, 'mine', 'Bash(make check)'), path.join(home, 'settings.json'));
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).permissions.profiles.mine, { base: 'read-only', allow: ['Bash(make check)'] });
  await assert.rejects(addAllowRule(root, home, 'missing', 'Bash(x)'), /No settings file defines profile missing/);
  await assert.rejects(addAllowRule(root, home, 'mine', 'bash(x)'), /unknown tool bash/);
});

test('the CLI lists profiles and checks a command against one', async t => {
  const { root, home } = await project(t, { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'], ask: ['Bash(git push *)'], deny: ['Bash(rm:*)'], beyondMode: 'ask' } }, agents: { reviewer: 'review' } });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  const listed = run('permissions');
  assert.match(listed.stdout, /^main {2}no profile: the mode its requester or the user chooses$/m);
  assert.match(listed.stdout, /^reviewer {2}profile review, at most read-only; asks the user beyond it\n {2}allow: Bash\(npm test:\*\)\n {2}ask: {3}Bash\(git push \*\)\n {2}deny: {2}Bash\(rm:\*\)$/m);
  assert.match(listed.stdout, /^oracle {2}profile read-only, at most read-only$/m);
  assert.match(run('permissions', 'check', 'reviewer', 'npm test 2>&1').stdout, /^allow: profile review lets reviewer run it, even beyond its read-only mode/);
  assert.match(run('permissions', 'check', 'reviewer', 'npm test; rm -rf /').stdout, /^deny: a deny rule of profile review covers it/);
  assert.match(run('permissions', 'check', 'reviewer', 'git push').stdout, /^ask: profile review asks the user each time/);
  assert.deepEqual(JSON.parse(run('permissions', 'check', 'main', 'ls', '--json').stdout), { agent: 'main', profile: null, base: null, decision: 'mode' });
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ permissions: { profiles: { r: { allow: ['npm test'] } } } }));
  const broken = run('permissions');
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /settings\.json: permissions\.profiles\.r\.allow: "npm test" is not Tool or Tool\(specifier\)/);
});

// --- helpers ------------------------------------------------------------------------

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.handler = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
      serverRequest(method, params) { return this.handler(method, params); },
      async call(tool, args) {
        return JSON.parse((await this.handler('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

// --- step 3: the sandbox floor and review copies -------------------------------------

const git = (cwd, ...args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

test('a floor puts Claude Bash in the OS sandbox and keeps file tools in the workspace', async () => {
  const root = path.join(tmpdir(), 'alp-floor-root');
  const asked = [];
  const readOnly = claudePermissions('read-only', () => 'read-only', { allow: ['Bash(npm test *)'], ask: [], deny: ['Bash(rm *)'], beyondMode: 'refuse', floor: 'read-only', floorRoot: root }, async request => { asked.push(request); return { allow: true }; });
  assert.deepEqual(readOnly.sandbox, { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true, filesystem: { denyWrite: [root], denyRead: credentialDenials().denyRead } });
  // Inside a read-only floor any command runs; the OS stops its writes.
  assert.equal((await readOnly.canUseTool('Bash', { command: 'node -e "1"' }, {})).behavior, 'allow');
  // Leaving the sandbox needs an allow rule; a deny rule refuses even that.
  assert.equal((await readOnly.canUseTool('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }, {})).behavior, 'allow');
  assert.deepEqual(await readOnly.canUseTool('Bash', { command: 'touch x', dangerouslyDisableSandbox: true }, {}), { behavior: 'deny', message: 'Bash runs inside the sandbox; leaving it needs an allow rule in your permission profile' });
  assert.deepEqual(await readOnly.canUseTool('Bash', { command: 'npm test && rm -rf a', dangerouslyDisableSandbox: true }, {}), { behavior: 'deny', message: 'A deny rule of your permission profile covers it' });
  assert.equal((await readOnly.canUseTool('Edit', { file_path: path.join(root, 'a.js') }, {})).behavior, 'deny');
  assert.deepEqual(asked, []);

  const asking = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [], beyondMode: 'ask', floor: 'read-only', floorRoot: root }, async request => { asked.push(request); return { allow: true, always: true }; });
  const left = await asking.canUseTool('Bash', { command: 'npm ci', dangerouslyDisableSandbox: true }, {});
  assert.deepEqual([left.behavior, asked.map(request => [request.reason, request.rule])], ['allow', [['mode', 'Bash(npm ci)']]]);

  // An ask rule the user allows runs that command outside the read-only floor, which would refuse its write.
  const ruled = claudePermissions('read-only', () => 'read-only', { allow: [], ask: ['Bash(touch *)'], deny: [], beyondMode: 'ask', floor: 'read-only', floorRoot: root }, async request => { asked.push(request); return { allow: true }; });
  assert.deepEqual(await ruled.canUseTool('Bash', { command: 'touch once.txt' }, { decisionReasonType: 'rule' }), { behavior: 'allow', updatedInput: { command: 'touch once.txt', dangerouslyDisableSandbox: true } });
  assert.deepEqual(asked.at(-1), { tool: 'Bash', input: { command: 'touch once.txt' }, reason: 'rule' });

  // A workspace floor: the workspace and temp files, nothing else, for Bash and file tools alike.
  const workspace = claudePermissions('workspace-write', () => 'workspace-write', { allow: [], ask: [], deny: [], beyondMode: 'refuse', floor: 'workspace-write', floorRoot: root });
  assert.deepEqual(workspace.sandbox, { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true });
  assert.equal((await workspace.canUseTool('Write', { file_path: path.join(root, 'src', 'a.js') }, {})).behavior, 'allow');
  assert.equal((await workspace.canUseTool('Write', { file_path: 'relative/b.js' }, {})).behavior, 'allow');
  assert.equal((await workspace.canUseTool('Write', { file_path: path.join(tmpdir(), 'scratch.txt') }, {})).behavior, 'allow');
  assert.deepEqual(await workspace.canUseTool('Edit', { file_path: '/etc/hosts' }, {}), { behavior: 'deny', message: 'Outside your workspace' });
  assert.deepEqual(await workspace.canUseTool('Bash', { command: 'curl x', dangerouslyDisableSandbox: true }, {}), { behavior: 'deny', message: 'Bash runs inside the sandbox; leaving it needs an allow rule in your permission profile' });
  // Without a floor nothing changes.
  assert.equal(claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [] }).sandbox, undefined);
});

test('a review copy has the requester\'s state, links node_modules, and leaves the tree untouched', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'repo');
  await mkdir(path.join(checkout, 'src'), { recursive: true });
  await mkdir(path.join(checkout, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(checkout, '.gitignore'), 'node_modules\ndist\n');
  await writeFile(path.join(checkout, 'src', 'a.js'), 'one\n');
  git(checkout, 'init', '-q'); git(checkout, 'config', 'core.autocrlf', 'false'); git(checkout, 'add', '-A'); git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  await writeFile(path.join(checkout, 'src', 'a.js'), 'two\n');
  await writeFile(path.join(checkout, 'src', 'new.js'), 'new\n');
  await mkdir(path.join(checkout, 'dist'));
  await writeFile(path.join(checkout, 'dist', 'out.js'), 'built\n');
  const status = git(checkout, 'status', '--porcelain');

  const copy = await createCopy(path.join(checkout, 'src'), path.join(directory, 'copies'), 'a1');
  assert.equal(copy.workdir, path.join(copy.path, 'src'));
  assert.equal(await readFile(path.join(copy.path, 'src', 'a.js'), 'utf8'), 'two\n');
  assert.equal(await readFile(path.join(copy.path, 'src', 'new.js'), 'utf8'), 'new\n');
  // A reviewer sees the requester's diff and status there.
  assert.equal(git(copy.path, 'diff'), git(checkout, 'diff'));
  assert.equal(git(copy.path, 'status', '--porcelain'), status);
  await assert.rejects(readFile(path.join(copy.path, 'dist', 'out.js')));
  assert.ok((await readdir(path.join(copy.path, 'node_modules'))).includes('dep'));
  await writeFile(path.join(copy.path, 'src', 'a.js'), 'changed in the copy\n');
  await mkdir(path.join(copy.path, 'dist'), { recursive: true });
  await writeFile(path.join(copy.path, 'dist', 'out.js'), 'rebuilt\n');
  assert.equal(await readFile(path.join(checkout, 'src', 'a.js'), 'utf8'), 'two\n');
  assert.equal(await readFile(path.join(checkout, 'dist', 'out.js'), 'utf8'), 'built\n');
  assert.equal(git(checkout, 'status', '--porcelain'), status);

  await removeCopy(copy);
  await assert.rejects(readdir(copy.path));
  assert.ok((await readdir(path.join(checkout, 'node_modules'))).includes('dep'));
  assert.doesNotMatch(git(checkout, 'worktree', 'list'), /copies/);
  const again = await createCopy(checkout, path.join(directory, 'copies'), 'a2');
  assert.equal(await reclaimCopies(path.join(directory, 'copies')), 1);
  await assert.rejects(readdir(again.path));
});

test('an assignment with workdir copy writes, builds and tests in its copy, which goes when it ends', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, { profiles: { review: { base: 'read-only', workdir: 'copy', allow: ['Bash(npm test *)'] } }, agents: { reviewer: 'review' } });
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'add', '-A'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const previous = process.env.ALP_CLAUDE_SANDBOX;
  process.env.ALP_CLAUDE_SANDBOX = '1';
  defer(() => { if (previous === undefined) delete process.env.ALP_CLAUDE_SANDBOX; else process.env.ALP_CLAUDE_SANDBOX = previous; });
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs'), copyDir: path.join(directory, 'copies') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });

  // Codex: the copy is its workspace; the requester's tree is not writable.
  const started = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review and test', wait: false });
  assert.equal(started.workdirNote, 'reviewer works in a disposable copy of your tree; nothing it changes reaches yours');
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const codex = runtimes[2];
  const copy = codex.config.cwd;
  assert.ok(copy.startsWith(path.join(directory, 'copies')));
  assert.deepEqual([codex.config.sandbox, codex.started[0].params.sandboxPolicy.type, codex.started[0].params.sandboxPolicy.writableRoots], ['workspace-write', 'workspaceWrite', [copy]]);
  assert.match(codex.config.developerInstructions, /You work in a disposable copy of your requester's tree at /);
  // To ALP it stays read-only: it claims nothing.
  assert.match((await codex.call('alp_pin', { kind: 'claim', paths: ['src'], body: 'x' })).error, /read-only session changes no files/);
  assert.match(codex.config.developerInstructions, new RegExp(`mirroring ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. .*Never run a command in, or write to, the requester's tree\\.`));
  assert.match(main.config.developerInstructions, /reviewer: at most read-only, may also run Bash\(npm test \*\), and works in a disposable copy of your tree, so name paths relative to the project/);
  // Codex lets a command write where it runs, so ALP reports commands run in the requester's tree.
  codex.notification('item/started', { threadId: codex.threadId, item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm test'", cwd: root, status: 'inProgress' } });
  codex.notification('item/started', { threadId: codex.threadId, item: { type: 'commandExecution', id: 'c2', command: "/bin/zsh -lc 'git diff'", cwd: copy, status: 'inProgress' } });
  codex.call('alp_handoff', { outcome: 'complete', summary: 'Tests pass in the copy' });
  codex.finish('Done');
  const waited = await main.call('alp_wait', {});
  assert.match(JSON.stringify(waited), /reviewer ran commands in your tree, not its copy; they may have changed files there: npm test \(in [^)]*[\\/]project\)"/);
  await assert.rejects(readdir(copy));

  // Claude: Bash sandboxed to the copy.
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review again', model: 'claude:claude-opus-5-5', wait: false });
  await until(() => runtimes.length === 4 && runtimes[3].started.length === 1);
  const claude = runtimes[3];
  assert.deepEqual([claude.config.sandbox, claude.config.floor], ['workspace-write', 'workspace-write']);
  // t-cde5 g2: a read-only profile's Bash never leaves the sandbox, so the note offers no way out.
  assert.match(claude.config.developerInstructions, /Bash runs in an OS sandbox: it writes only .*copies.* and temporary files, and has no network\. Run any command you need for your work in it\. Your profile is read-only, so every command runs in it, also one your profile allows or the user approves/);
  assert.doesNotMatch(claude.config.developerInstructions, /dangerouslyDisableSandbox/);
  claude.call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  claude.finish('Done');
  await main.call('alp_wait', {});

  // Without the sandbox, a Claude reviewer cannot get a copy.
  process.env.ALP_CLAUDE_SANDBOX = '0';
  assert.match((await main.call('alp_delegate', { agent: 'reviewer', task: 'Once more', model: 'claude:claude-opus-5-5' })).error, /A review copy on Claude needs its Bash sandbox/);
  main.finish('Done');
  await until(async () => (await readdir(path.join(directory, 'copies')).catch(() => [])).length === 0);
  const copies = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).event).filter(event => event.startsWith('copy.'));
  await until(async () => (await copies()).length === 7);
  assert.deepEqual(await copies(), ['copy.created', 'copy.escape', 'copy.removed', 'copy.created', 'copy.removed', 'copy.created', 'copy.removed']);
});

test('advisors on Claude run Bash in a read-only floor by default', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t);
  const previous = process.env.ALP_CLAUDE_SANDBOX;
  process.env.ALP_CLAUDE_SANDBOX = '1';
  defer(() => { if (previous === undefined) delete process.env.ALP_CLAUDE_SANDBOX; else process.env.ALP_CLAUDE_SANDBOX = previous; });
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  assert.equal(main.config.floor, undefined);
  assert.deepEqual([supervisor.config.floor, supervisor.config.sandbox], ['read-only', 'read-only']);
  assert.match(supervisor.config.developerInstructions, /Bash runs in an OS sandbox: it writes nothing but temporary files, and has no network\. Run any command you need for your work in it\./);
  assert.doesNotMatch(supervisor.config.developerInstructions, /dangerouslyDisableSandbox/);
});


test('read-only Claude lead and peers get the same inspection sandbox regardless of profile', async t => {
  const defer = teardown(t);
  const { directory, root, home } = await project(t, { agents: { lead: 'workspace-write' } });
  const previous = process.env.ALP_CLAUDE_SANDBOX;
  process.env.ALP_CLAUDE_SANDBOX = '1';
  defer(() => { if (previous === undefined) delete process.env.ALP_CLAUDE_SANDBOX; else process.env.ALP_CLAUDE_SANDBOX = previous; });
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'cafe', supervisor: false }, permissions: { agents: { lead: 'workspace-write' } } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'claude:claude-sonnet-4-6' });
  const main = runtimes[0];
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Assess security' }] });
  await main.call('alp_delegate', { agent: 'lead', task: 'Assess', mode: 'read-only' });
  const lead = runtimes.at(-1);
  await until(() => lead.started.length === 1);
  await lead.call('alp_delegate', { agent: 'peer', task: 'Inspect history', mode: 'read-only' });
  const peer = runtimes.at(-1);
  await until(() => peer.started.length === 1);
  for (const child of [lead, peer]) {
    assert.equal(child.config.floor, 'read-only');
    const permissions = claudePermissions('read-only', () => 'read-only', { allow: [], deny: [], ...child.config.permissions, floor: child.config.floor, floorRoot: root });
    for (const [tool, input] of [['Glob', { pattern: '**/*' }], ['Grep', { pattern: 'secret' }], ['Bash', { command: 'git status --short && git log -1 && git ls-files' }]]) {
      assert.equal((await permissions.canUseTool(tool, input)).behavior, 'allow');
    }
    assert.equal((await permissions.canUseTool('Write', { file_path: path.join(root, 'x'), content: 'x' })).behavior, 'deny');
    assert.equal((await permissions.canUseTool('Bash', { command: 'touch x', dangerouslyDisableSandbox: true })).behavior, 'deny');
  }
  assert.ok(claudePermissions('read-only', undefined, { allow: [], deny: [], floor: 'read-only', floorRoot: root }).tools.includes('Bash'));
});
