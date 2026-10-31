import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime, claudeToolShapes } from '@anhlp/alp-runtime';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
      async call(tool, args, callId = `${tool}-${index}-${++calls}`) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      shell(command, exitCode = 0) {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'commandExecution', id: `cmd-${++calls}`, command, status: 'completed', exitCode, aggregatedOutput: '' } });
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

async function setup(t, settings, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-supervisor-'));
  let runtime;
  // After hooks run in the order they are added: stop the runtime, which may still be writing its
  // run logs, before removing them (rm raced it: ENOTEMPTY on runs/ in CI).
  t.after(async () => { await runtime?.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'home');
  await initProject(root);
  if (settings) await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify(settings));
  const runtimes = [];
  runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: library, runLogDir: path.join(directory, 'runs'), ...options });
  const prompt = (id, text, session = 'root') => runtime.prompt(session, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  return { root, library, runtime, runtimes, prompt };
}

test('main starts a supervisor on Sonnet 5 that reviews each turn and asks main between turns', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const [main, supervisor] = runtimes;
  assert.deepEqual([main.kind, main.config.model, main.config.thinking, main.config.sandbox], ['claude', 'claude-opus-5-5', 'high', 'full-access']);
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_lesson'));
  assert.match(main.config.developerInstructions, /A supervisor reviews your process after each turn/);
  assert.deepEqual([supervisor.kind, supervisor.config.model, supervisor.config.thinking, supervisor.config.sandbox], ['claude', 'claude-sonnet-5', 'medium', 'read-only']);
  assert.deepEqual(supervisor.config.dynamicTools.map(tool => tool.name), ['alp_send', 'alp_board', 'alp_task']);
  assert.match(supervisor.config.developerInstructions, /Supervisor — process reviewer for main/);
  assert.ok(supervisor.config.developerInstructions.includes(`Lessons main has recorded: ${path.join(root, '.alp/lessons.md')} and ${path.join(library, 'lessons.md')}`));
  for (const tool of [...main.config.dynamicTools, ...supervisor.config.dynamicTools]) {
    const shape = Object.keys(claudeToolShapes[tool.name] ?? {}).sort();
    const properties = Object.keys(tool.inputSchema.properties).sort();
    if (tool.name === 'alp_task' || tool.name === 'alp_delegate') assert.ok(properties.every(property => shape.includes(property)), `${tool.name} has a field Claude lacks`);
    else assert.deepEqual(shape, properties, `${tool.name} differs for Claude`);
  }
  assert.ok(['alp_lesson', 'alp_skill', 'alp_issue'].every(name => main.config.dynamicTools.some(tool => tool.name === name)));
  const status = runtime.status('root');
  assert.deepEqual(status.sessions.map(session => session.agent), ['main', 'supervisor']);
  assert.equal(runtime.snapshot('root').busy, false);

  await prompt('m1', 'Fix the login bug');
  main.shell('npm test', 1);
  assert.equal((await main.call('alp_pin', { kind: 'decision', body: 'Keep the session cookie' })).kind, 'decision');
  main.finish('Fixed it, tests pass');
  // Busy from the end of main's turn, so an idle-tree reap cannot close it before the review starts.
  assert.equal(runtime.snapshot('root').busy, true);
  await until(() => supervisor.started.length === 1);
  const digest = supervisor.started[0].params.input.at(-1).text;
  assert.match(digest, /user asked main: Fix the login bug/);
  assert.match(digest, /main shell completed \(exit 1\): npm test/);
  assert.match(digest, /main pinned decision: Keep the session cookie/);
  assert.match(digest, /main final message: Fixed it, tests pass/);
  // Each line has its local time; ALP notes how long the user waited, and states main's own session.
  assert.ok(digest.split('\n').filter(line => line.startsWith('- ')).every(line => /^- \[\d\d:\d\d:\d\d\] /.test(line)), digest);
  assert.match(digest, /main answered the user \d+ s after their message of \d\d:\d\d:\d\d/);
  assert.match(digest, /main's session: claude:claude-opus-5-5, thinking high, mode full-access\. Judge main by this session and its own instructions; your system prompt describes your session/);
  assert.match(supervisor.config.developerInstructions, /a later lesson on the same point refines or replaces an earlier one/);
  assert.match(supervisor.config.developerInstructions, /Leaving the user waiting\./);
  // The tree stays busy while its supervisor reviews.
  assert.equal(runtime.snapshot('root').busy, true);

  assert.match((await supervisor.call('alp_pin', { kind: 'finding', body: 'x' })).error, /only uses alp_send, alp_board and alp_task/);
  assert.equal((await supervisor.call('alp_send', { to: 'parent', kind: 'note', body: 'Tests failed with exit 1 but you said they pass. Why, and what will you do from now on?' })).sent.startsWith('#'), true);
  supervisor.finish('Asked about the claimed test result');
  await until(() => main.started.length === 2);
  assert.match(main.started[1].params.input.at(-1).text, /note from supervisor[\s\S]*exit 1 but you said they pass/);
  // Main answers in its reply; mail to the supervisor says so instead of "not one of your assignments".
  assert.match((await main.call('alp_send', { to: 'supervisor', kind: 'note', body: 'I will report what the command printed.' })).error, /answer its note in your reply/);
  assert.match((await main.call('alp_send', { to: 'nobody', kind: 'note', body: 'x' })).error, /Not one of your live assignments/);

  assert.equal((await main.call('alp_lesson', { scope: 'project', lesson: 'Report the test result the command actually printed.' })).recorded, true);
  assert.equal((await main.call('alp_lesson', { scope: 'user', lesson: 'Never claim checks that did not pass.' })).recorded, true);
  assert.match((await main.call('alp_lesson', { scope: 'team', lesson: 'x' })).error, /scope/);
  main.finish('I misread the output; recorded the lesson');
  await settle();
  // Answering the supervisor is not reviewed again.
  assert.equal(supervisor.started.length, 1);
  assert.equal(runtime.snapshot('root').busy, false);
  assert.match(await readFile(path.join(root, '.alp/lessons.md'), 'utf8'), /# ALP lessons[\s\S]*- \d{4}-\d\d-\d\d: Report the test result the command actually printed\./);
  assert.match(await readFile(path.join(library, 'lessons.md'), 'utf8'), /Never claim checks that did not pass\./);

  // A later session follows the lessons, and so does its supervisor.
  await runtime.open('next', { cwd: root });
  await until(() => runtimes.length === 4 && runtimes[3].calls.some(call => call.method === 'thread/start'));
  for (const later of [runtimes[2], runtimes[3]]) {
    assert.match(later.config.developerInstructions, /For every project:\n# ALP lessons[\s\S]*Never claim checks[\s\S]*For this project:[\s\S]*Report the test result/);
  }
  await runtime.close('root');
  assert.equal(supervisor.closed, true);
});

test('a supervisor note waits for main\'s running turn, and a turn that ends during a review is reviewed next', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  await prompt('m1', 'First task');
  main.finish('First done');
  await until(() => supervisor.started.length === 1);
  await prompt('m2', 'Second task');
  await supervisor.call('alp_send', { to: 'parent', kind: 'note', body: 'Why no reviewer on the first task?' });
  await settle();
  assert.equal(main.calls.some(call => call.method === 'turn/steer'), false);
  // Main's own wait for assignments does not take the note either.
  assert.deepEqual((await main.call('alp_wait', { timeoutMs: 20 })).events, []);
  main.finish('Second done');
  await until(() => main.started.length === 3);
  assert.match(main.started[2].params.input.at(-1).text, /Why no reviewer on the first task\?/);
  // The second turn's digest waited for the first review to end.
  assert.equal(supervisor.started.length, 1);
  supervisor.finish('sound');
  await until(() => supervisor.started.length === 2);
  assert.match(supervisor.started[1].params.input.at(-1).text, /user asked main: Second task[\s\S]*Second done/);
  assert.doesNotMatch(supervisor.started[1].params.input.at(-1).text, /First task/);
});

test('a turn the user stops is not reviewed, and the tree goes idle', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  await prompt('m1', 'Count slowly to 200');
  await runtime.interrupt('root');
  await settle();
  // A review would ask main why it stopped and leave mail an interrupted root never wakes for.
  assert.equal(supervisor.started.length, 0);
  assert.equal(runtime.snapshot('root').busy, false);
  // The next turn the user asks for is reviewed as before.
  await prompt('m2', 'Where did you stop?');
  main.finish('At 4');
  await until(() => supervisor.started.length === 1);
  assert.match(supervisor.started[0].params.input.at(-1).text, /user asked main: Where did you stop\?[\s\S]*main final message: At 4/);
});

test('a project without agent copies runs the built-in supervisor and gets no copies', async t => {
  const { root, runtime, runtimes } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  assert.match(runtimes[1].config.developerInstructions, /Supervisor — process reviewer/);
  await assert.rejects(readdir(path.join(root, '.alp/agents')), { code: 'ENOENT' });
});

test('no supervisor when settings turn it off or the project uses a custom graph', async t => {
  for (const settings of [{ workflow: { mode: 'cafe', supervisor: false } }, { delegation: { main: ['peer'] } }]) {
    const { root, runtime, runtimes, prompt } = await setup(t, settings);
    await runtime.open('root', { cwd: root });
    await settle();
    assert.equal(runtimes.length, 1);
    assert.equal(runtimes[0].config.dynamicTools.some(tool => tool.name === 'alp_lesson'), false);
    await prompt('m1', 'Task');
    assert.match((await runtimes[0].call('alp_lesson', { scope: 'project', lesson: 'x' })).error, /Only a supervised main/);
    await runtime.shutdown();
  }
});

/** Proposes a skill, checks it returns pending at once, answers its approval and returns the result mail. */
async function approvedSkill(runtime, pending, reply) {
  const events = []; const off = runtime.onEvent(e => events.push(e));
  try {
    const result = await pending;
    assert.equal(result.status, 'pending_approval', JSON.stringify(result));
    const question = runtime.questions().find(q => q.id === result.approvalId);
    assert.ok(question);
    if (reply === null) runtime.answer(question.id, { dismiss: true, reason: 'Not now' });
    else runtime.answer(question.id, { text: reply });
    let terminal;
    await until(() => { terminal = events.find(e => e.event.type === 'mail' && e.event.mail.assignment === result.approvalId); return terminal; });
    return { question, pending: result, result: JSON.parse(terminal.event.mail.body.slice(terminal.event.mail.body.indexOf('{'))) };
  } finally { off(); }
}

for (const form of ['bare', 'dated', 'bullet-dated']) for (const whitespace of [false, true]) test(`skill approval matches ${form} lessons across user and project files (whitespace=${whitespace})`, async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  await prompt('m1', 'Work');
  const main = runtimes[0];
  const files = [path.join(root, '.alp/lessons.md'), path.join(library, 'lessons.md')];
  for (const scope of ['project', 'user']) {
    await main.call('alp_lesson', { scope, lesson: 'Run the check first.' });
    await main.call('alp_lesson', { scope, lesson: 'Keep this unrelated rule.' });
    await main.call('alp_lesson', { scope, lesson: 'Run the check first. Then report.' });
  }
  // Stored whitespace and date differ from the submitted representation.
  if (whitespace) for (const file of files) await writeFile(file, (await readFile(file, 'utf8')).replace('Run the check first.', 'Run  the\tcheck first.'));
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const input = form === 'bare' ? 'Run the check first.' : `${form === 'bullet-dated' ? '- ' : ''}2020-01-02: Run the check first.`;
  const draft = { name: 'check-first', description: 'Run checks before reporting.', body: '# Check first', roles: ['main', 'peer'], lessons: [input, input, '2020-01-02: Missing rule.'] };
  if (whitespace) draft.lessons.push('Run the check first.', '2020-01-02: Run the check first.', '- 2020-01-02: Run the check first.');
  const rejected = await approvedSkill(runtime, main.call('alp_skill', draft), 'Reject');
  assert.equal(rejected.result.saved, false);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  await assert.rejects(readFile(path.join(library, 'skills/check-first/SKILL.md')), { code: 'ENOENT' });
  const { result } = await approvedSkill(runtime, main.call('alp_skill', { ...draft, requestId: 'approve' }), 'Approve');
  assert.equal(result.approved, true);
  assert.equal(result.saved, path.join(library, 'skills/check-first/SKILL.md'));
  assert.deepEqual(result.lessonsRemoved, ['Run the check first.']);
  assert.deepEqual(result.lessonsNotFound, ['Missing rule.']);
  for (const file of files) {
    const after = await readFile(file, 'utf8');
    assert.equal(after, before[files.indexOf(file)].split('\n').filter(line => !line.endsWith(whitespace ? 'Run  the\tcheck first.' : 'Run the check first.')).join('\n'));
  }
  assert.match(await readFile(result.saved, 'utf8'), /# Check first/);
  const roles = JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8'));
  for (const role of draft.roles) assert.ok(roles[role].includes(draft.name));
});

test('main distills lessons into a skill scoped to the roles it picks, saved only after the user approves', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const main = runtimes[0];
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_skill'));
  await prompt('m1', 'Work');
  const lessons = ['Run the command before reporting its result.', 'Quote the exit code in the handoff.', 'Keep briefs short.'];
  for (const lesson of lessons) await main.call('alp_lesson', { scope: lesson.startsWith('Keep') ? 'user' : 'project', lesson });
  const skill = { name: 'verify-claims', description: 'Use before reporting any check: run it and quote what it printed.', body: '# Verify claims\n\n1. Run the check.\n2. Quote its output.', roles: ['main', 'peer', 'oracle'], lessons: [...lessons.slice(0, 2), `2020-01-02: ${lessons[0]}`, `- 2020-01-02: ${lessons[1]}`] };
  assert.match((await main.call('alp_skill', { ...skill, roles: ['main', 'tester'] })).error, /Unknown roles: tester/);
  assert.equal(runtime.questions().length, 0);

  const rejected = await approvedSkill(runtime, main.call('alp_skill', skill), 'Make it shorter');
  assert.deepEqual(rejected.question.options, ['Approve', 'Reject']);
  assert.match(rejected.question.body, /Roles that get it: main, peer, oracle\.[\s\S]*- Run the command before reporting its result\.[\s\S]*name: verify-claims\ndescription: "Use before reporting/);
  assert.deepEqual([rejected.result.approved, rejected.result.saved, rejected.result.feedback], [false, false, 'Make it shorter']);
  await assert.rejects(readFile(path.join(library, 'skills/verify-claims/SKILL.md'), 'utf8'), { code: 'ENOENT' });
  // The same draft replays its decision; a fresh requestId proposes it again on purpose.
  const replayed = await main.call('alp_skill', skill);
  assert.deepEqual([replayed.status, replayed.approvalId], ['resolved', rejected.pending.approvalId]);
  assert.equal(runtime.questions().length, 0);
  const dismissed = await approvedSkill(runtime, main.call('alp_skill', { ...skill, requestId: 'again' }), null);
  assert.deepEqual([dismissed.result.approved, dismissed.result.outcome], [false, 'dismissed']);

  const { result, question } = await approvedSkill(runtime, main.call('alp_skill', { ...skill, requestId: 'approve' }), 'Approve');
  assert.equal(question.body, rejected.question.body, 'the user sees the whole skill each time');
  assert.deepEqual([result.status, result.approved, result.saved], ['resolved', true, path.join(library, 'skills', 'verify-claims', 'SKILL.md')]);
  assert.deepEqual(result.lessonsRemoved.sort(), lessons.slice(0, 2).sort());
  assert.equal(result.lessonsNotFound, undefined, 'duplicate representations do not report missing lessons');
  assert.match(await readFile(path.join(library, 'skills/verify-claims/SKILL.md'), 'utf8'), /^---\nname: verify-claims\n[\s\S]*1\. Run the check\./);
  const roles = JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8'));
  for (const role of ['main', 'peer', 'oracle']) assert.ok(roles[role].includes('verify-claims'), role);
  assert.equal(roles.lead.includes('verify-claims'), false);
  assert.ok(roles.main.includes('xia'), 'the shipped assignments stay');
  assert.doesNotMatch(await readFile(path.join(root, '.alp/lessons.md'), 'utf8'), /Run the command|exit code/);
  assert.match(await readFile(path.join(library, 'lessons.md'), 'utf8'), /Keep briefs short/);
  assert.equal((await main.call('alp_skill', { ...skill, requestId: 'approve' })).saved, result.saved, 'a replay does not save twice');
  assert.match((await main.call('alp_skill', { ...skill, requestId: 'third' })).error, /already has a skill named verify-claims/);
  main.finish();

  // Later sessions of those roles list it.
  await runtime.open('next', { cwd: root });
  await until(() => runtimes.length === 4);
  assert.ok(runtimes[2].config.developerInstructions.includes(`- verify-claims (${path.join(library, 'skills/verify-claims/SKILL.md')})`));
});

const skillDraft = { name: 'quote-output', description: 'Quote what a check printed.', body: '1. Run it.\n2. Quote it.', roles: ['main'] };
const skillMail = (events, approvalId) => events.filter(e => e.event.type === 'mail' && e.event.mail.assignment === approvalId);

test('skill approval returns before the user decides, survives turn completion, and its decision wakes main', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  const events = []; runtime.onEvent(e => events.push(e));
  await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
  const main = runtimes[0];
  const pending = await Promise.race([main.call('alp_skill', skillDraft), new Promise(resolve => setTimeout(() => resolve({ status: 'blocked' }), 100))]);
  assert.equal(pending.status, 'pending_approval');
  const question = runtime.questions()[0]; assert.equal(pending.approvalId, question.id);
  assert.match(question.body, /name: quote-output[\s\S]*1\. Run it\.\n2\. Quote it\./);
  // Main keeps working; another question cannot stack on the pending approval.
  assert.ok(Array.isArray((await main.call('alp_board', {})).claims));
  assert.match((await main.call('alp_skill', { ...skillDraft, name: 'other-skill' })).error, /already waiting for the user/);
  main.finish(); await settle();
  await prompt('second', 'Other work');
  assert.equal((await main.call('alp_skill', skillDraft)).approvalId, pending.approvalId);
  main.finish(); await settle();
  assert.equal(runtime.questions().length, 1);
  const started = main.started.length;
  await assert.rejects(readFile(path.join(library, 'skills/quote-output/SKILL.md'), 'utf8'), { code: 'ENOENT' });
  runtime.answer(question.id, { text: 'Approve' });
  await until(() => skillMail(events, pending.approvalId).length === 1);
  assert.equal(skillMail(events, pending.approvalId)[0].sessionId, 'root');
  assert.match(await readFile(path.join(library, 'skills/quote-output/SKILL.md'), 'utf8'), /name: quote-output/);
  await until(() => main.started.length === started + 1);
  assert.match(main.started.at(-1).params.input.at(-1).text, /Skill approval result: .*"saved"/);
  assert.throws(() => runtime.answer(question.id, { text: 'Approve' }), /No question/);
  assert.equal((await main.call('alp_skill', skillDraft)).status, 'resolved');
  await settle(); assert.equal(skillMail(events, pending.approvalId).length, 1);
});

test('skill approvals report refusal, dismissal, timeout and save errors once and save nothing', async t => {
  for (const scenario of ['Reject', 'dismiss', 'timeout', 'failure']) {
    await t.test(scenario, async t => {
      const { root, library, runtime, runtimes, prompt } = await setup(t, undefined, { userAskTimeoutMs: scenario === 'timeout' ? 40 : 2000 });
      const events = []; runtime.onEvent(e => events.push(e));
      await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
      const main = runtimes[0]; const draft = { ...skillDraft, requestId: 'one' };
      const pending = await main.call('alp_skill', draft);
      assert.equal(pending.status, 'pending_approval');
      assert.equal((await main.call('alp_skill', draft)).approvalId, pending.approvalId);
      assert.equal(runtime.questions().length, 1);
      assert.match((await main.call('alp_skill', { ...draft, body: 'Changed' })).error, /different draft/);
      const file = path.join(library, 'skills/quote-output/SKILL.md');
      // A directory where the file goes makes saving fail after the approval.
      if (scenario === 'failure') await mkdir(file, { recursive: true });
      const q = runtime.questions()[0];
      if (scenario !== 'timeout') runtime.answer(q.id, scenario === 'dismiss' ? { dismiss: true } : { text: scenario === 'failure' ? 'Approve' : scenario });
      await until(() => skillMail(events, pending.approvalId).length === 1);
      const result = JSON.parse(skillMail(events, pending.approvalId)[0].event.mail.body.slice('Skill approval result: '.length));
      assert.equal(result.saved, false);
      if (scenario === 'failure') { assert.equal(result.approved, true); assert.ok(result.error); }
      else {
        assert.equal(result.outcome, scenario === 'timeout' ? 'unanswered' : scenario === 'dismiss' ? 'dismissed' : 'answered');
        await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
      }
      assert.doesNotMatch(await readFile(path.join(library, 'role-skills.json'), 'utf8').catch(() => ''), /quote-output/);
      const replay = await main.call('alp_skill', draft);
      assert.equal(replay.status, 'resolved'); assert.equal(replay.approvalId, q.id);
      await settle(); assert.equal(skillMail(events, pending.approvalId).length, 1); assert.equal(runtime.questions().length, 0);
    });
  }
});

test('interrupt, close and shutdown cancel a pending skill approval; an approval followed by interrupt saves nothing', async t => {
  for (const operation of ['interrupt', 'close', 'shutdown', 'approve then interrupt']) {
    await t.test(operation, async t => {
      const { root, library, runtime, runtimes, prompt } = await setup(t);
      const events = []; runtime.onEvent(e => events.push(e));
      await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
      const pending = await runtimes[0].call('alp_skill', skillDraft);
      assert.equal(pending.status, 'pending_approval');
      if (operation === 'approve then interrupt') { runtime.answer(pending.approvalId, { text: 'Approve' }); await runtime.interrupt('root'); }
      else if (operation === 'shutdown') await runtime.shutdown();
      else await runtime[operation]('root');
      assert.equal(runtime.questions().length, 0);
      assert.throws(() => runtime.answer(pending.approvalId, { text: 'Approve' }), /No question/);
      await settle();
      await assert.rejects(readFile(path.join(library, 'skills/quote-output/SKILL.md'), 'utf8'), { code: 'ENOENT' });
      const terminal = skillMail(events, pending.approvalId);
      if (operation === 'close' || operation === 'shutdown') assert.equal(terminal.length, 0);
      else { assert.equal(terminal.length, 1); assert.match(terminal[0].event.mail.body, /"outcome":"canceled"/); }
    });
  }
});

async function approvedIssue(runtime, pending, answer) {
  const events = []; const off = runtime.onEvent(e => events.push(e));
  try {
    const result = await pending;
    assert.equal(result.status, 'pending_approval');
    const question = runtime.questions().find(q => q.id === result.approvalId);
    assert.ok(question);
    runtime.answer(question.id, { text: answer });
    let terminal;
    await until(() => { terminal = events.find(e => e.event.type === 'mail' && e.event.mail.assignment === result.approvalId); return terminal; });
    return { question, result: JSON.parse(terminal.event.mail.body.slice('Issue approval result: '.length)) };
  } finally { if (typeof off === 'function') off(); }
}

test('main searches, then opens or comments on GitHub issues only with the user\'s approval', async t => {
  const calls = [];
  const github = async (args, { input }) => {
    calls.push({ args, input });
    return args[1] === 'list' ? JSON.stringify([{ number: 7, title: 'Login fails', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/7' }]) : `https://github.com/${args[args.indexOf('-R') + 1]}/issues/${args[1] === 'create' ? 8 : 7}\n`;
  };
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: root });
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const main = runtimes[0];
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_issue'));
  await prompt('m1', 'Work');

  const found = await main.call('alp_issue', { action: 'search', target: 'project', query: 'login' });
  assert.equal(found.repo, 'acme/widgets');
  assert.equal(found.issues[0].number, 7);
  assert.deepEqual(calls[0].args.slice(0, 4), ['issue', 'list', '-R', 'acme/widgets']);

  const draft = { action: 'create', target: 'alp', title: 'Supervisor misses lead routing', body: 'Steps: ...' };
  const declined = await approvedIssue(runtime, main.call('alp_issue', draft), 'Reject');
  assert.match(declined.question.body, /open an issue in phucanh08\/alp \(ALP itself\)[\s\S]*Title: Supervisor misses lead routing\n\nSteps: \.\.\./);
  assert.equal(declined.result.approved, false);
  assert.equal(calls.length, 1);
  const created = (await approvedIssue(runtime, main.call('alp_issue', { ...draft, requestId: 'approved-again' }), 'Approve')).result;
  assert.deepEqual([created.posted, created.url], [true, 'https://github.com/phucanh08/alp/issues/8']);
  assert.deepEqual(calls[1].args, ['issue', 'create', '-R', 'phucanh08/alp', '--title', 'Supervisor misses lead routing', '--body-file', '-']);
  assert.match(calls[1].input, /^Steps: \.\.\.\n\n---\n_Drafted by an ALP agent and posted with the user's approval\._$/);
  const commented = (await approvedIssue(runtime, main.call('alp_issue', { action: 'comment', target: 'project', issue: 7, body: 'Also fails on Safari.' }), 'đồng ý')).result;
  assert.equal(commented.url, 'https://github.com/acme/widgets/issues/7');
  assert.deepEqual(calls[2].args, ['issue', 'comment', '7', '-R', 'acme/widgets', '--body-file', '-']);

  // Assignments report problems to their requester instead.
  const delegated = await main.call('alp_delegate', { agent: 'peer', task: 'Look', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  assert.match((await runtimes[2].call('alp_issue', { action: 'search', target: 'alp', query: 'x' })).error, /Only main files issues/);
  assert.equal(delegated.status, 'running');
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git'], { cwd: root });
  assert.match((await main.call('alp_issue', { action: 'search', target: 'project', query: 'x' })).error, /not on GitHub/);
});

test('the digest says when the user\'s message got no reply in main\'s turn', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const [main, supervisor] = runtimes;
  await prompt('m1', 'Build the site');
  main.shell('npm run build', 0);
  main.finish('');
  await until(() => supervisor.started.length === 1);
  assert.match(supervisor.started[0].params.input.at(-1).text, /the user's message of \d\d:\d\d:\d\d got no reply in this turn/);
});


test('issue labels are validated before asking the user to approve a draft', async t => {
  const calls = [];
  const github = async (args) => { calls.push(args); return args[0] === 'label' ? JSON.stringify([{ name: 'bug' }]) : 'https://github.com/phucanh08/alp/issues/8'; };
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github });
  await runtime.open('root', { cwd: root });
  await prompt('m1', 'File a bug');
  const main = runtimes[0];
  const draft = { action: 'create', target: 'alp', title: 'Inspection fails', body: 'Steps', labels: ['runtime'] };
  let invalid;
  const pending = main.call('alp_issue', draft).then(result => { invalid = result; });
  await until(() => invalid || runtime.questions().length);
  assert.equal(runtime.questions().length, 0, 'unknown labels must not ask for approval');
  await pending;
  assert.deepEqual(invalid.missingLabels, ['runtime']);
  assert.equal(runtime.questions().length, 0);
  assert.equal(calls.length, 1);
  const created = (await approvedIssue(runtime, main.call('alp_issue', { ...draft, labels: ['bug'] }), 'Approve')).result;
  assert.equal(created.posted, true);
  assert.deepEqual(calls.at(-1).slice(-2), ['--label', 'bug']);
});

test('issue approval returns before the user decides and survives turn completion', async t => {
  const writes = [];
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github: async args => { writes.push(args); return 'https://github.com/phucanh08/alp/issues/9'; } });
  const events = []; runtime.onEvent(e => events.push(e));
  await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
  const main = runtimes[0];
  const pending = await Promise.race([main.call('alp_issue', { action: 'create', target: 'alp', title: 'Bug', body: 'Full evidence' }), new Promise(resolve => setTimeout(() => resolve({ status: 'blocked' }), 100))]);
  assert.equal(pending.status, 'pending_approval');
  assert.equal(writes.length, 0);
  const question = runtime.questions()[0]; assert.equal(pending.approvalId, question.id);
  main.finish(); await settle();
  await prompt('second', 'Other work');
  const replay = await main.call('alp_issue', { action: 'create', target: 'alp', title: 'Bug', body: 'Full evidence' });
  assert.equal(replay.approvalId, pending.approvalId);
  main.finish(); await settle();
  assert.equal(runtime.questions().length, 1);
  runtime.answer(question.id, { text: 'Approve' });
  await until(() => events.some(e => e.event.type === 'mail' && e.event.mail.body?.includes('"posted":true')));
  assert.equal(writes.length, 1);
  assert.match(question.body, /Full evidence[\s\S]*Drafted by an ALP agent/);
  await until(() => main.started.length === 3);
  assert.throws(() => runtime.answer(question.id, { text: 'Approve' }), /No question/);
  assert.equal(writes.length, 1);
});

test('issue approvals report refusal, dismissal, timeout and posting errors once without retry', async t => {
  for (const scenario of ['Reject', 'revise first', 'dismiss', 'timeout', 'failure']) {
    await t.test(scenario, async t => {
      let writes = 0;
      const { root, runtime, runtimes, prompt } = await setup(t, undefined, { userAskTimeoutMs: scenario === 'timeout' ? 40 : 2000, github: async () => { writes++; throw new Error('injected posting failure'); } });
      const events = []; runtime.onEvent(e => events.push(e));
      await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
      const main = runtimes[0]; const draft = { action: 'comment', target: 'alp', issue: 114, body: 'Evidence', requestId: 'one' };
      const pending = await main.call('alp_issue', draft);
      assert.equal(pending.status, 'pending_approval');
      assert.equal((await main.call('alp_issue', draft)).approvalId, pending.approvalId);
      assert.equal(runtime.questions().length, 1);
      assert.match((await main.call('alp_issue', { ...draft, body: 'Changed' })).error, /different draft/);
      const q = runtime.questions()[0];
      if (scenario !== 'timeout') runtime.answer(q.id, scenario === 'dismiss' ? { dismiss: true } : { text: scenario === 'failure' ? 'Approve' : scenario });
      const terminal = () => events.filter(e => e.event.type === 'mail' && e.event.mail.assignment === pending.approvalId);
      await until(() => terminal().length === 1);
      const result = JSON.parse(terminal()[0].event.mail.body.slice('Issue approval result: '.length));
      assert.equal(result.posted, false);
      assert.equal(writes, scenario === 'failure' ? 1 : 0);
      if (scenario === 'failure') assert.match(result.error, /injected posting failure/);
      else assert.equal(result.outcome, scenario === 'timeout' ? 'unanswered' : scenario === 'dismiss' ? 'dismissed' : 'answered');
      const replay = await main.call('alp_issue', draft);
      assert.equal(replay.status, 'resolved'); assert.equal(replay.approvalId, q.id);
      await settle(); assert.equal(terminal().length, 1); assert.equal(runtime.questions().length, 0);
    });
  }
});

test('issue approval leaves tools, user steering and child result delivery responsive', async t => {
  const writes = [];
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github: async args => { writes.push(args); return 'url'; } });
  const events = []; runtime.onEvent(e => events.push(e));
  await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
  const main = runtimes[0]; const draft = { action: 'create', target: 'alp', title: 'Bug', body: 'All facts', labels: [] };
  const p = await main.call('alp_issue', draft);
  assert.equal(p.status, 'pending_approval');
  assert.ok(Array.isArray((await main.call('alp_board', {})).claims));
  const child = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect', mode: 'read-only' });
  await until(() => runtimes[2]?.started.length);
  await runtime.prompt('root', { clientMessageId: 'steer', delivery: 'steer', content: [{ type: 'text', text: 'Keep working' }] });
  assert.equal(runtime.questions().length, 1);
  await runtimes[2].call('alp_handoff', { outcome: 'complete', summary: 'Inspected' });
  runtimes[2].finish('Evidence');
  await until(() => events.some(e => e.event.type === 'mail' && e.event.mail.assignment === child.assignmentId));
  runtime.answer(p.approvalId, { text: 'Approve' });
  await until(() => writes.length === 1);
  await until(() => events.some(e => e.event.type === 'mail' && e.event.mail.assignment === p.approvalId));
  assert.equal(events.filter(e => e.event.type === 'mail' && e.event.mail.assignment === p.approvalId)[0].sessionId, 'root');
  assert.equal((await main.call('alp_issue', draft)).status, 'resolved');
  assert.equal(writes.length, 1);
});


test('interrupt, close and shutdown cancel pending issue approvals; in-flight posting is not repeated', async t => {
  for (const operation of ['interrupt', 'close', 'shutdown', 'inflight']) {
    await t.test(operation, async t => {
      let writes = 0; let release;
      const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github: async () => { writes++; if (operation === 'inflight') await new Promise(resolve => { release = resolve; }); return 'url'; } });
      const events = []; runtime.onEvent(e => events.push(e));
      await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
      const pending = await runtimes[0].call('alp_issue', { action: 'comment', target: 'alp', issue: 114, body: 'Facts' });
      if (operation === 'inflight') {
        runtime.answer(pending.approvalId, { text: 'Approve' }); await until(() => release);
        await runtime.close('root'); release();
      } else if (operation === 'shutdown') await runtime.shutdown();
      else await runtime[operation]('root');
      assert.equal(runtime.questions().length, 0);
      assert.throws(() => runtime.answer(pending.approvalId, { text: 'Approve' }), /No question/);
      await settle();
      assert.equal(writes, operation === 'inflight' ? 1 : 0);
      assert.equal(events.filter(e => e.event.type === 'question.resolved' && e.event.questionId === pending.approvalId).length, 1);
      if (operation !== 'interrupt') assert.equal(events.filter(e => e.event.type === 'mail' && e.event.mail.assignment === pending.approvalId).length, 0);
    });
  }
});

test('issue preflight cannot create approval after interruption or close', async t => {
  for (const operation of ['interrupt', 'close']) await t.test(operation, async t => {
    let labels; let entered = false; let writes = 0;
    const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github: async args => {
      if (args[0] === 'label') { entered = true; return new Promise(resolve => { labels = resolve; }); }
      writes++; return 'url';
    } });
    await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
    const pending = runtimes[0].call('alp_issue', { action: 'create', target: 'alp', title: 'Bug', body: 'Facts', labels: ['bug'] });
    await until(() => entered);
    await runtime[operation]('root'); labels(JSON.stringify([{ name: 'bug' }]));
    const result = await pending;
    assert.match(result.error, /canceled|closed/i);
    assert.equal(runtime.questions().length, 0); assert.equal(writes, 0);
  });
});

test('approval immediately followed by interrupt cancels before GitHub dispatch', async t => {
  let writes = 0;
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github: async () => { writes++; return 'url'; } });
  const events = []; runtime.onEvent(e => events.push(e));
  await runtime.open('root', { cwd: root }); await prompt('first', 'Work');
  const pending = await runtimes[0].call('alp_issue', { action: 'comment', target: 'alp', issue: 114, body: 'Facts' });
  runtime.answer(pending.approvalId, { text: 'Approve' });
  await runtime.interrupt('root');
  const terminal = () => events.filter(e => e.event.type === 'mail' && e.event.mail.assignment === pending.approvalId);
  await until(() => terminal().length === 1);
  assert.equal(writes, 0);
  assert.match(terminal()[0].event.mail.body, /"outcome":"canceled"/);
});

/** Proposes a lesson curate, answers its approval and returns the result mail. */
async function curatedLessons(runtime, pending, reply) {
  const events = []; const off = runtime.onEvent(e => events.push(e));
  try {
    const result = await pending;
    assert.equal(result.status, 'pending_approval', JSON.stringify(result));
    const question = runtime.questions().find(q => q.id === result.approvalId);
    assert.ok(question);
    runtime.answer(question.id, { text: reply });
    let terminal;
    await until(() => { terminal = events.find(e => e.event.type === 'mail' && e.event.mail.assignment === result.approvalId); return terminal; });
    return { question, result: JSON.parse(terminal.event.mail.body.slice('Lesson curate result: '.length)) };
  } finally { off(); }
}

test('main merges, shortens and removes lessons only after one user approval', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  await prompt('m1', 'Work');
  const main = runtimes[0];
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_lesson_curate'));
  assert.ok(claudeToolShapes.alp_lesson_curate);
  const project = path.join(root, '.alp/lessons.md');
  const user = path.join(library, 'lessons.md');
  for (const lesson of ['Run the check first.', 'Always run the check before reporting.', 'Keep this rule.', 'An obsolete rule.']) await main.call('alp_lesson', { scope: 'project', lesson });
  await main.call('alp_lesson', { scope: 'user', lesson: 'A user rule that is far too long and repeats itself.' });
  const before = [await readFile(project, 'utf8'), await readFile(user, 'utf8')];
  // Unknown lessons are refused before any approval exists.
  const unknown = await main.call('alp_lesson_curate', { changes: [{ scope: 'project', remove: ['Not recorded.'] }] });
  assert.deepEqual(unknown.missing, ['project: Not recorded.']);
  assert.equal(runtime.questions().length, 0);
  assert.match((await main.call('alp_lesson_curate', { changes: [] })).error, /changes/);
  const changes = [
    { scope: 'project', remove: ['Run the check first.', '2026-01-01: Always run the check before reporting.'], add: 'Run the check before reporting it.', reason: 'duplicates' },
    { scope: 'project', remove: ['An obsolete rule.'] },
    { scope: 'user', remove: ['A user rule that is far too long and repeats itself.'], add: 'A short user rule.' },
  ];
  const rejected = await curatedLessons(runtime, main.call('alp_lesson_curate', { changes }), 'Reject');
  assert.equal(rejected.result.applied, false);
  assert.match(rejected.question.question ?? JSON.stringify(rejected.question), /Remove: An obsolete rule\./);
  assert.deepEqual([await readFile(project, 'utf8'), await readFile(user, 'utf8')], before);
  const { result } = await curatedLessons(runtime, main.call('alp_lesson_curate', { changes, requestId: 'go' }), 'Approve');
  assert.equal(result.applied, true);
  assert.equal(result.added, 2);
  const after = await readFile(project, 'utf8');
  assert.match(after, /# ALP lessons/);
  assert.match(after, /Keep this rule\./);
  assert.match(after, /- \d{4}-\d\d-\d\d: Run the check before reporting it\./);
  assert.doesNotMatch(after, /Run the check first\.|Always run|obsolete/);
  assert.match(await readFile(user, 'utf8'), /A short user rule\./);
  assert.doesNotMatch(await readFile(user, 'utf8'), /far too long/);
  // A replay of the approved draft applies nothing again.
  const replay = await main.call('alp_lesson_curate', { changes, requestId: 'go' });
  assert.equal(replay.status, 'resolved');
  assert.equal(replay.applied, true);
  assert.equal((await readFile(project, 'utf8')).match(/Run the check before reporting it\./g).length, 1);
  assert.match((await main.call('alp_lesson_curate', { changes: [changes[1]], requestId: 'go' })).error, /different draft/);
  // A dismissal changes nothing.
  const kept = await readFile(project, 'utf8');
  const pending = await main.call('alp_lesson_curate', { changes: [{ scope: 'project', remove: ['Keep this rule.'] }] });
  runtime.answer(pending.approvalId, { dismiss: true, reason: 'Not now' });
  await until(async () => (await main.call('alp_lesson_curate', { changes: [{ scope: 'project', remove: ['Keep this rule.'] }] })).status === 'resolved');
  assert.equal(await readFile(project, 'utf8'), kept);
});

test('main retires a library skill only after the user approves; it is kept in retired-skills and leaves role-skills.json', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const main = runtimes[0];
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_skill_retire'));
  await prompt('m1', 'Work');
  await until(() => main.turnId);
  const skillFile = path.join(library, 'skills/xia/SKILL.md');
  const before = await readFile(skillFile, 'utf8');
  assert.ok(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')).main.includes('xia'));
  assert.match((await main.call('alp_skill_retire', { name: 'no-such-skill', reason: 'Old' })).error, /no skill named no-such-skill/);
  assert.match((await main.call('alp_skill_retire', { name: '../xia', reason: 'Old' })).error, /needs its name/);
  assert.equal(runtime.questions().length, 0);

  // Rejected, dismissed: nothing moves.
  const rejected = await approvedSkill(runtime, main.call('alp_skill_retire', { name: 'xia', reason: 'Covered by another skill.' }), 'Keep it');
  assert.deepEqual(rejected.question.options, ['Approve', 'Reject']);
  assert.match(rejected.question.body, /retire the skill xia[\s\S]*Covered by another skill\.[\s\S]*retired-skills[\s\S]*main/);
  assert.deepEqual([rejected.result.approved, rejected.result.retired, rejected.result.feedback], [false, false, 'Keep it']);
  assert.equal(await readFile(skillFile, 'utf8'), before);
  const replayed = await main.call('alp_skill_retire', { name: 'xia', reason: 'Covered by another skill.' });
  assert.deepEqual([replayed.status, replayed.retired], ['resolved', false], 'a replay returns the decision, not a new approval');
  const dismissed = await approvedSkill(runtime, main.call('alp_skill_retire', { name: 'xia', reason: 'Covered by another skill.', requestId: 'again' }), null);
  assert.deepEqual([dismissed.result.approved, dismissed.result.outcome], [false, 'dismissed']);
  assert.equal(await readFile(skillFile, 'utf8'), before);
  assert.ok(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')).main.includes('xia'));

  const { result } = await approvedSkill(runtime, main.call('alp_skill_retire', { name: 'xia', reason: 'Covered by another skill.', requestId: 'yes' }), 'Approve');
  assert.equal(result.approved, true, JSON.stringify(result));
  assert.ok(result.retired.startsWith(path.join(library, 'retired-skills', 'xia-')));
  assert.ok(result.roles.includes('main'));
  await assert.rejects(readFile(skillFile, 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(result.retired, 'SKILL.md'), 'utf8'), before, 'the retired skill is kept whole');
  const roles = JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8'));
  assert.ok(Object.values(roles).every(list => !list.includes('xia')));
  assert.equal((await main.call('alp_skill_retire', { name: 'xia', reason: 'Covered by another skill.', requestId: 'yes' })).retired, result.retired, 'a replay does not retire twice');
});

test('only a supervised main retires skills', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t, { workflow: { mode: 'cafe', supervisor: false } });
  await runtime.open('root', { cwd: root });
  await prompt('m1', 'Work');
  await until(() => runtimes[0]?.turnId);
  assert.equal(runtimes[0].config.dynamicTools.some(tool => tool.name === 'alp_skill_retire'), false);
  assert.match((await runtimes[0].call('alp_skill_retire', { name: 'xia', reason: 'Old' })).error, /Only a supervised main/);
  assert.ok(await readFile(path.join(library, 'skills/xia/SKILL.md'), 'utf8'));
  assert.equal(runtime.questions().length, 0);
});

test('only a supervised main curates lessons', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t, { workflow: { mode: 'cafe', supervisor: false } });
  await runtime.open('root', { cwd: root });
  await prompt('m1', 'Work');
  await until(() => runtimes[0]?.turnId);
  assert.equal(runtimes[0].config.dynamicTools.some(tool => tool.name === 'alp_lesson_curate'), false);
  assert.match((await runtimes[0].call('alp_lesson_curate', { changes: [{ scope: 'project', remove: ['x'] }] })).error, /Only a supervised main/);
});

test('a supervised main keeps one monthly curate job, replaces an older session\'s, and settings turn it off', async t => {
  const jobs = [];
  const handler = async (action, params) => {
    if (action === 'list') return { jobs: jobs.filter(job => job.status === 'pending') };
    if (action === 'cancel') { jobs.find(job => job.id === params.id).status = 'cancelled'; return {}; }
    if (action === 'create') { const job = { id: `sch_${jobs.length}`, status: 'pending', ...params }; jobs.push(job); return { job }; }
  };
  const { root, library, runtime, runtimes } = await setup(t);
  runtime.bindSchedules(handler);
  await runtime.open('root', { cwd: root });
  await until(() => jobs.length === 1);
  assert.match(jobs[0].prompt, /^\[alp-curate\] [\s\S]*curate skill/);
  assert.equal(jobs[0].sessionId, 'root');
  assert.equal(jobs[0].keepsSession, false);
  assert.match(jobs[0].dueAt, /^\d{4}-\d\d-01T02:00:00\.000Z$/);
  assert.ok(Date.parse(jobs[0].dueAt) > Date.now());
  await runtime.open('second', { cwd: root });
  await until(() => jobs.length === 2);
  assert.equal(jobs[0].status, 'cancelled');
  assert.equal(jobs[1].sessionId, 'second');
  await settle();
  assert.equal(jobs.filter(job => job.status === 'pending').length, 1);
  // Off in the user's settings; a project setting takes precedence.
  await writeFile(path.join(library, 'settings.json'), JSON.stringify({ curate: { monthly: false } }));
  await runtime.open('third', { cwd: root });
  await until(() => runtimes.length >= 6);
  await settle();
  assert.equal(jobs.length, 2);
  const projectSettings = path.join(root, '.alp/settings.json');
  await writeFile(projectSettings, JSON.stringify({ ...JSON.parse(await readFile(projectSettings, 'utf8')), curate: { monthly: true } }));
  await runtime.open('fourth', { cwd: root });
  await until(() => jobs.length === 3);
  assert.equal(jobs[2].sessionId, 'fourth');
});

test('two opens of one project at once leave one curate job, and a failing schedule never fails the open', async t => {
  const jobs = [];
  let fail = false;
  const handler = async (action, params) => {
    if (fail) throw new Error('alpd is down');
    await new Promise(resolve => setTimeout(resolve, 10));
    if (action === 'list') return { jobs: jobs.filter(job => job.status === 'pending') };
    if (action === 'cancel') { jobs.find(job => job.id === params.id).status = 'cancelled'; return {}; }
    if (action === 'create') { const job = { id: `sch_${jobs.length}`, status: 'pending', ...params }; jobs.push(job); return { job }; }
  };
  const { root, runtime } = await setup(t);
  runtime.bindSchedules(handler);
  await Promise.all([runtime.open('a', { cwd: root }), runtime.open('b', { cwd: root })]);
  await until(() => jobs.length === 2);
  await settle();
  assert.equal(jobs.filter(job => job.status === 'pending').length, 1);
  fail = true;
  await runtime.open('c', { cwd: root });
  await settle();
  assert.ok(runtime.snapshot('c'));
});
