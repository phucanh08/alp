import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ago, duration, renderLog, renderPs } from '@anhlp/alp-client/render';
import { isTaskId } from '@anhlp/alp-core/tasks';
import { connect } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { start, running, stop } from './daemon.js';
import { taskProject } from './tasks.js';

function printer(json) {
  const depth = new Map();
  const agents = new Map();
  const printed = new Set();
  const latest = new Map();
  const line = (sessionId, text) => console.log(`${'  '.repeat(depth.get(sessionId) ?? 0)}${text}`);
  return envelope => {
    if (json) { console.log(JSON.stringify(envelope)); return; }
    const { sessionId, event } = envelope;
    if (event.type === 'session.opened') {
      const { session } = event;
      depth.set(sessionId, session.parentId ? (depth.get(session.parentId) ?? 0) + 1 : 0);
      agents.set(sessionId, session.agent);
      line(sessionId, `▸ ${session.agent} (${session.runtime}:${session.model}, ${session.mode}) ${sessionId}`);
    } else if (event.type === 'item') {
      const { item } = event;
      latest.set(item.id, { sessionId, item });
      if (item.kind === 'tool_call' && item.status !== 'running' && !printed.has(item.id)) {
        printed.add(item.id);
        const detail = item.detail.type === 'shell' ? item.detail.command : item.name === 'alp_delegate' ? `delegate → ${item.detail.input?.agent}` : item.name;
        line(sessionId, `  ${item.status === 'failed' ? '✗' : '✓'} ${detail}`);
      }
      if (item.kind === 'notice') line(sessionId, `  ${item.level === 'error' ? '‼' : item.level === 'warning' ? '!' : 'ℹ'} ${item.text}`);
      if (item.kind === 'todo') {
        line(sessionId, '  tasks:');
        for (const entry of item.items) line(sessionId, `    ${entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◐' : '☐'} ${entry.text}`);
      }
    } else if (event.type === 'mail') {
      line(sessionId, `  ✉ ${event.mail.kind} from ${event.mail.from}`);
    } else if (event.type === 'question') {
      const { question } = event;
      line(sessionId, `  ? ${question.agent} asks you [${question.id}]: ${question.body}${question.options?.length ? ` (${question.options.join(' | ')})` : ''}`);
      line(sessionId, `    answer here, or with: alp answer ${question.id} <text>`);
    } else if (event.type === 'question.resolved') {
      line(sessionId, `  ↳ ${event.questionId} ${event.outcome}${event.answer !== undefined ? `: ${event.answer}` : ''}`);
    } else if (event.type === 'turn.ended') {
      for (const [id, entry] of latest) {
        if (entry.sessionId !== sessionId || printed.has(id) || entry.item.kind !== 'assistant_message') continue;
        printed.add(id);
        line(sessionId, `  ${agents.get(sessionId) ?? 'agent'}: ${entry.item.text.replace(/\n/g, `\n${'  '.repeat((depth.get(sessionId) ?? 0) + 2)}`)}`);
      }
      if (event.state !== 'completed') line(sessionId, `  turn ${event.state}${event.error ? `: ${event.error.message}` : ''}`);
    } else if (event.type === 'prompt.failed') {
      line(sessionId, `  prompt failed: ${event.error.message}`);
    } else if (event.type === 'session.failed') {
      line(sessionId, `  runtime failed: ${event.error.message}`);
    }
  };
}

/** Reads answers to questions for the user from the terminal, one question at a time. */

function answerer(client) {
  const waiting = [];
  let rl;
  const ask = () => {
    if (rl || !waiting.length) return;
    const question = waiting[0];
    rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`answer ${question.id}> `, text => {
      rl.close();
      rl = undefined;
      waiting.shift();
      // An empty line leaves the question for another client, such as Paseo or alp answer.
      if (text.trim()) client.request('question.answer', { questionId: question.id, text }).catch(error => console.error(`alp: ${error.message}`));
      ask();
    });
  };
  return {
    accept(event) {
      if (event.type === 'question') { waiting.push(event.question); ask(); }
      if (event.type === 'question.resolved') {
        const index = waiting.findIndex(question => question.id === event.questionId);
        if (index === 0 && rl) { rl.close(); rl = undefined; console.error(''); }
        if (index >= 0) waiting.splice(index, 1);
        ask();
      }
    },
    close() { rl?.close(); rl = undefined; },
  };
}

/** Streams a tree until its root is idle; the first Ctrl-C interrupts it, the second detaches. */

function follow(client, rootId, print, { untilIdle, interactive = false }) {
  const answering = interactive ? answerer(client) : undefined;
  const done = new Promise((resolve, reject) => {
    let failed = false;
    let interrupted = false;
    const finish = () => { process.off('SIGINT', onSignal); answering?.close(); resolve(!failed); };
    const onSignal = () => {
      if (interrupted) { finish(); return; }
      interrupted = true;
      console.error('Interrupting… press Ctrl-C again to detach.');
      client.request('session.interrupt', { sessionId: rootId }).catch(() => {});
    };
    process.on('SIGINT', onSignal);
    client.onClose(error => { process.off('SIGINT', onSignal); reject(error); });
    let rootEnded = false;
    client.onEvent(envelope => {
      print(envelope);
      answering?.accept(envelope.event);
      const { sessionId, event } = envelope;
      if (event.type === 'turn.ended') {
        if (sessionId === rootId) {
          failed = event.state !== 'completed';
          rootEnded = true;
        }
        if (!untilIdle || !rootEnded) return;
        // The root may still have assignments, mail, or a supervisor review; it is done
        // only when idle, so any turn that ends in the tree checks again.
        setTimeout(() => {
          client.request('session.get', { sessionId: rootId }).then(({ session }) => { if (!session.busy) finish(); }, finish);
        }, 50);
        return;
      }
      if (sessionId !== rootId) return;
      if (event.type === 'turn.started') {
        rootEnded = false;
      } else if (event.type === 'session.closed' || event.type === 'session.failed' || event.type === 'prompt.failed') {
        failed ||= event.type !== 'session.closed';
        finish();
      }
    });
  });
  // A request can fail before the caller awaits this; closing the client must not crash the CLI then.
  done.catch(() => {});
  return done;
}

async function run(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    agent: { type: 'string' }, team: { type: 'string' }, profile: { type: 'string' }, workflow: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' },
    thinking: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  const text = positionals.join(' ').trim();
  if (!text) throw new UsageError();
  // --profile and --workflow are the option's names before teams.
  const teams = [values.team, values.profile, values.workflow].filter(Boolean);
  if (new Set(teams).size > 1) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  try {
    const spec = { cwd: path.resolve(values.project ?? process.cwd()), persist: true, agent: values.agent, workflow: teams[0], model: values.model, mode: values.mode, thinking: values.thinking };
    const sessionId = `cli-${randomUUID()}`;
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true, interactive: !values.json && process.stdin.isTTY });
    await client.request('session.create', { sessionId, spec });
    await client.request('session.prompt', { sessionId, clientMessageId: randomUUID(), content: [{ type: 'text', text }] });
    if (!await done) process.exitCode = 1;
    await client.request('session.release', { sessionId }).catch(() => {});
  } finally {
    client.close();
  }
}

async function ps(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const [{ sessions }, pauses] = await Promise.all([client.request('session.list', { includeClosed: values.all }), client.request('daemon.pauses')]).finally(() => client.close());
  printPauses(pauses, false);
  if (!sessions.length) { console.log(values.all ? 'No sessions' : 'No live sessions'); return; }
  for (const line of renderPs(sessions)) console.log(line);
}

async function attach(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const client = await running();
  try {
    const done = follow(client, positionals[0], printer(values.json), { untilIdle: false, interactive: !values.json && process.stdin.isTTY });
    const { session } = await client.request('session.attach', { sessionId: positionals[0] });
    if (session.id !== positionals[0]) console.error(`Following root ${session.id}`);
    // A closed session has only history; resume it with alp send.
    if (session.status === 'idle' || session.status === 'running') await done;
    else console.error(`Session is ${session.lastError?.code ?? session.status}; resume it with: alp send ${session.id} <text>`);
  } finally {
    client.close();
  }
}

/** Steers a running root, prompts an idle one, or resumes a closed one; then follows it until idle. */

async function send(args) {
  const { values, positionals: [sessionId, ...words] } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const text = words.join(' ').trim();
  if (!sessionId || !text) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  try {
    const { session } = await client.request('session.get', { sessionId });
    if (session.parentId) {
      // An assignment gets the text as mail from the user, in its running turn.
      await client.request('session.message', { sessionId, text });
      if (!values.json) console.error(`Sent to ${session.agent} as mail from the user`);
      return;
    }
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true, interactive: !values.json && process.stdin.isTTY });
    const live = session.status === 'idle' || session.status === 'running';
    if (live) await client.request('session.attach', { sessionId, replay: false });
    else await client.request('session.create', { sessionId, spec: { cwd: session.projectRoot } });
    const steer = live && !!session.activeTurnId;
    await client.request('session.prompt', { sessionId, clientMessageId: randomUUID(), delivery: steer ? 'steer' : 'auto', content: [{ type: 'text', text }] });
    if (!values.json) console.error(steer ? 'Steered the running turn' : live ? 'Started a turn' : 'Resumed the session');
    if (!await done) process.exitCode = 1;
    await client.request('session.release', { sessionId }).catch(() => {});
  } finally {
    client.close();
  }
}

async function questions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const { questions: pending } = await client.request('question.list').finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(pending)); return; }
  if (!pending.length) { console.log('No questions wait for you'); return; }
  for (const question of pending) {
    console.log(`${question.id}  ${question.agent}  ${ago(question.askedAt)} ago  root ${question.rootId}`);
    console.log(`  ${question.body.replace(/\n/g, '\n  ')}`);
    if (question.options?.length) console.log(`  options: ${question.options.join(' | ')}`);
  }
}

async function answer(args) {
  const { values, positionals: [questionId, ...words] } = parseArgs({ args, allowPositionals: true, options: { dismiss: { type: 'boolean' }, reason: { type: 'string' } } });
  const text = words.join(' ').trim();
  if (!questionId || (values.dismiss ? text : !text)) throw new UsageError();
  const client = await running();
  const result = await client.request('question.answer', values.dismiss ? { questionId, dismiss: true, reason: values.reason } : { questionId, text }).finally(() => client.close());
  console.log(`${values.dismiss ? 'Dismissed' : 'Answered'} ${result.questionId}`);
}

/** One tree as text: sessions by depth, then questions, unmerged worktrees and leases. */

function renderStatus(status, root) {
  const lines = [`${root?.title ? `"${root.title}"  ` : ''}${status.rootId}  ${status.sessions[0]?.projectRoot ?? ''}`];
  const depth = new Map();
  const assignments = new Map(status.assignments.map(assignment => [assignment.id, assignment]));
  for (const session of status.sessions) {
    depth.set(session.id, session.parentId ? (depth.get(session.parentId) ?? 0) + 1 : 0);
    const assignment = assignments.get(session.id);
    const where = assignment?.worktree ? `  worktree ${assignment.worktree.branch}` : '';
    const mail = session.unreadMail ? `  ✉${session.unreadMail}` : '';
    lines.push(`${'  '.repeat(depth.get(session.id) + 1)}${session.agent.padEnd(9)} ${session.state.padEnd(14)} idle ${duration(session.idleMs).padEnd(7)} ${session.runtime}:${session.model}  ${session.mode}${where}${mail}`);
  }
  for (const question of status.questions) lines.push(`  ? ${question.id} ${question.agent} asks (${ago(question.askedAt)}): ${question.body.split('\n')[0]}`);
  for (const worktree of status.worktrees) lines.push(`  ⎇ unmerged ${worktree.branch} from ${worktree.agent}: ${worktree.files.length} files${worktree.stat ? ` (${worktree.stat.trim()})` : ''}`);
  for (const lease of status.leases) lines.push(`  ⚿ ${lease.agent} holds the write lease on ${lease.checkout}`);
  for (const claim of status.claims ?? []) lines.push(`  ⚑ ${claim.agent} claims ${claim.paths.join(', ')}${claim.task ? ` for ${claim.task}` : ''}: ${claim.body.split('\n')[0].slice(0, 100)}`);
  return lines.join('\n');
}

/** A live dashboard of every tree, or of one, refreshed every second. */

async function top(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { once: { type: 'boolean' } } });
  if (positionals.length > 1) throw new UsageError();
  const client = await running();
  const frame = async () => {
    const { sessions } = await client.request('session.list', { rootsOnly: true });
    const roots = positionals.length ? sessions.filter(session => session.id === positionals[0]) : sessions;
    if (positionals.length && !roots.length) throw new Error(`Session ${positionals[0]} is not a live root`);
    const blocks = [];
    for (const root of roots) {
      const { status } = await client.request('session.status', { sessionId: root.id }).catch(() => ({}));
      if (status) blocks.push(renderStatus(status, root));
    }
    return `alp top  ${new Date().toLocaleTimeString()}  ${roots.length} live ${roots.length === 1 ? 'tree' : 'trees'}\n\n${blocks.join('\n\n') || 'No live sessions'}`;
  };
  try {
    if (values.once || !process.stdout.isTTY) { console.log(await frame()); return; }
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    while (!stop) {
      const text = await frame();
      process.stdout.write(`\x1b[2J\x1b[H${text}\n\n(Ctrl-C to exit)\n`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    client.close();
  }
}

/** The tree's assignment log: delegations, mail, handoffs, worktrees and questions to the user. */

async function log(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const client = await running();
  const { rootId, entries } = await client.request('session.log', { sessionId: positionals[0] }).finally(() => client.close());
  if (values.json) { for (const entry of entries) console.log(JSON.stringify(entry)); return; }
  if (!entries.length) { console.log(`No assignment log for ${rootId}`); return; }
  for (const line of renderLog(rootId, entries)) console.log(line);
}

/** The project board every agent on the project shares: live claims, then decisions and findings. */

async function board(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const projectRoot = path.resolve(values.project ?? process.cwd());
  const client = await running();
  const { pins } = await client.request('board.list', { projectRoot }).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(pins)); return; }
  if (!pins.length) { console.log(`The board for ${projectRoot} is empty`); return; }
  console.log(`Project board  ${projectRoot}`);
  for (const pin of pins) {
    const mark = pin.kind === 'claim' ? '⚑' : pin.kind === 'decision' ? '◆' : '•';
    console.log(`${mark} ${pin.kind.padEnd(8)} ${pin.id}  ${pin.agent}  ${ago(pin.at)} ago${pin.paths ? `  [${pin.paths.join(', ')}]` : ''}`);
    console.log(`  ${pin.body.replace(/\n/g, '\n  ')}`);
  }
}

function printPauses({ all, runtimes, parked }, always = true) {
  const line = (name, pause) => console.log(`⏸ ${name} paused since ${pause.since.slice(0, 16).replace('T', ' ')} by ${pause.by}: ${pause.reason}${pause.resetsAt ? `; the limit resets ${pause.resetsAt}` : ''}${pause.checkedAt ? `; ${name} last asked ${ago(pause.checkedAt)} ago` : ''}`);
  if (all) line('ALP', all);
  for (const [kind, pause] of Object.entries(runtimes)) line(kind, pause);
  for (const entry of parked) console.log(`  parked ${entry.agent} ${entry.assignmentId} (${entry.runtime}): ${entry.reason}`);
  if (always && !all && !Object.keys(runtimes).length) console.log('Nothing is paused');
}

/** alp pause: hold delegation and wakes on one runtime, or all; --now also parks running assignments. */

async function pause(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { now: { type: 'boolean' }, message: { type: 'string', short: 'm' }, json: { type: 'boolean' } } });
  if (positionals.length > 1 || (positionals[0] && !['codex', 'claude', 'status'].includes(positionals[0]))) throw new UsageError();
  const client = await running();
  const state = await (positionals[0] === 'status'
    ? client.request('daemon.pauses')
    : client.request('daemon.pause', { ...(positionals[0] ? { runtime: positionals[0] } : {}), now: !!values.now, ...(values.message ? { reason: values.message } : {}) })).finally(() => client.close());
  if (values.json) console.log(JSON.stringify(state));
  else printPauses(state);
}

/** alp resume: lift a pause; parked assignments continue where they stopped. */

async function resume(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length > 1 || (positionals[0] && !['codex', 'claude'].includes(positionals[0]))) throw new UsageError();
  const client = await running();
  const state = await client.request('daemon.resume', positionals[0] ? { runtime: positionals[0] } : {}).finally(() => client.close());
  if (values.json) console.log(JSON.stringify(state));
  else printPauses(state);
}

/** alp language: the language the user reads (ALPD §54); new sessions use it. */

async function recall(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  const [target, ...words] = positionals;
  const question = words.join(' ').trim();
  if (!target || !question) throw new UsageError();
  const byTask = isTaskId(target);
  const client = await running();
  const answer = await client.request('assignment.recall', {
    ...(byTask ? { taskId: target, projectRoot: await taskProject(values.project) } : { assignmentId: target }),
    question,
  }).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(answer)); return; }
  console.log(`${answer.agent} (assignment ${answer.assignmentId}${answer.taskId ? `, task ${answer.taskId}` : ''}, finished ${ago(answer.finishedAt)} ago):`);
  console.log(answer.answer);
}

/** alp web: opens the web app alpd serves on 127.0.0.1, with the token in the address (ALPD §61). */

async function interrupt(args) {
  if (args.length !== 1) throw new UsageError();
  const client = await running();
  await client.request('session.interrupt', { sessionId: args[0] }).finally(() => client.close());
  console.log('Interrupted');
}

export { printer, answerer, follow, run, ps, attach, send, questions, answer, renderStatus, top, log, board, printPauses, pause, resume, recall, interrupt };
