import { createInterface } from 'node:readline';
import type { AlpClient } from '@anhlp/alp-client/index';
import type { AlpEvent, Envelope, TimelineItem, UserQuestion } from '@anhlp/alp-protocol';

/** One line for a finished tool call: its command, or what a typed call touched (ALPD §4.2). */
export function toolLine(item: Extract<TimelineItem, { kind: 'tool_call' }>): string {
  const detail = item.detail ?? {};
  const first = (text: unknown) => String(text ?? '').split('\n')[0].slice(0, 200);
  switch (detail.type) {
    case 'shell': return detail.command;
    case 'read': case 'edit': case 'write': return `${item.name} ${detail.filePath}`;
    case 'search': return `${item.name} ${first(detail.query)}`;
    case 'fetch': return `${item.name} ${detail.url}`;
    case 'sub_agent': return `${item.name}${detail.description ? ` ${first(detail.description)}` : ''}`;
    case 'plain_text': return `${item.name}${detail.label ? ` ${detail.label}` : ''}`;
  }
  // alp_delegate's detail is the untyped `unknown` kind; its input names the agent.
  return item.name === 'alp_delegate' ? `delegate → ${(detail as { input?: { agent?: string } }).input?.agent}` : item.name;
}

/**
 * How a root's answer is labelled for a person: plain `main:` in a turn the user started, and the
 * turn's origin otherwise (`main [wake turn]:`), because `alp run` follows the root until it is idle
 * and can print turns ALP started after the answer, such as a supervisor's check-in (t-beb5).
 * Children's turns are assignments and keep the plain label. `--json` output does not change.
 */
export function answerLabel(agent: string, { root, origin }: { root: boolean; origin?: string }): string {
  return root && origin && origin !== 'user' ? `${agent} [${origin} turn]` : agent;
}

export function printer(json: boolean | undefined) {
  const depth = new Map<string, number>();
  const agents = new Map<string, string>();
  /** The origin of each session's current turn, from its turn.started. */
  const origins = new Map<string, string | undefined>();
  const printed = new Set<string>();
  const latest = new Map<string, { sessionId: string; item: TimelineItem }>();
  const line = (sessionId: string, text: string) => console.log(`${'  '.repeat(depth.get(sessionId) ?? 0)}${text}`);
  return (envelope: Envelope) => {
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
        const detail = toolLine(item);
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
    } else if (event.type === 'turn.started') {
      origins.set(sessionId, event.origin);
    } else if (event.type === 'turn.ended') {
      const label = answerLabel(agents.get(sessionId) ?? 'agent', { root: (depth.get(sessionId) ?? 0) === 0, origin: origins.get(sessionId) });
      for (const [id, entry] of latest) {
        if (entry.sessionId !== sessionId || printed.has(id) || entry.item.kind !== 'assistant_message') continue;
        printed.add(id);
        line(sessionId, `  ${label}: ${entry.item.text.replace(/\n/g, `\n${'  '.repeat((depth.get(sessionId) ?? 0) + 2)}`)}`);
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

export function answerer(client: AlpClient) {
  const waiting: UserQuestion[] = [];
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = () => {
    if (rl || !waiting.length) return;
    const question = waiting[0];
    rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`answer ${question.id}> `, text => {
      rl!.close();
      rl = undefined;
      waiting.shift();
      // An empty line leaves the question for another client, such as Paseo or alp answer.
      if (text.trim()) client.request('question.answer', { questionId: question.id, text }).catch((error: Error) => console.error(`alp: ${error.message}`));
      ask();
    });
  };
  return {
    accept(event: AlpEvent) {
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

export function follow(client: AlpClient, rootId: string, print: (envelope: Envelope) => void, { untilIdle, interactive = false, targetOnly = false, promptId }: { untilIdle: boolean; interactive?: boolean; targetOnly?: boolean; promptId?: string }): Promise<boolean> {
  const answering = interactive ? answerer(client) : undefined;
  const done = new Promise<boolean>((resolve, reject) => {
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
    client.onClose(error => { process.off('SIGINT', onSignal); answering?.close(); reject(error); });
    let rootEnded = false;
    client.onEvent(envelope => {
      if (targetOnly && envelope.sessionId !== rootId) return;
      if (promptId && envelope.event.type === 'prompt.failed' && envelope.event.clientMessageId !== promptId) return;
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
