// A gateway + alpd stand-in for the controller's unit tests: real JSON-RPC frames over an
// in-memory transport, a per-root stored timeline with cursors (§8), replay before the attach
// answer, idle roots closed when nobody watches, prompt receipts, tasks with revisions. Tests drop
// connections and fail requests at chosen points to prove the recovery rules.

export class FakeHost {
  constructor({ principal } = {}) {
    this.principal = principal ?? { id: 'p1', label: 'tests', permissions: ['session.read', 'session.write', 'project.read', 'project.write'], workspaces: ['/w/a', '/w/b'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }, { path: '/w/b', canonical: '/w/b' }] };
    this.capabilities = ['attach.after', 'prompt.receipts', 'task', 'team', 'library', 'settings.language'];
    /** @type {Map<string, any>} */
    this.roots = new Map();
    this.connections = new Set();
    this.calls = [];
    this.opens = 0;
    this.refuse = undefined;
    /** method → handler(params, connection) run before the default; return undefined to go on. */
    this.intercept = new Map();
    this.receipts = new Map();
    this.tasks = [];
    this.taskRev = 0;
    this.questions = new Map();
    this.epoch = 'e1';
  }

  count(method) { return this.calls.filter(call => call.method === method).length; }

  /** The controller's `open` option. */
  open = async ({ signal } = {}) => {
    this.opens++;
    if (this.refuse) throw this.refuse;
    if (signal?.aborted) throw signal.reason;
    return { transport: this.#connect(), principal: structuredClone(this.principal) };
  };

  #connect() {
    const messages = new Set();
    const closes = new Set();
    let ended = false;
    const connection = { attached: new Set(), transport: undefined, deliver: undefined, end: undefined };
    const end = close => {
      if (ended) return;
      ended = true;
      this.connections.delete(connection);
      messages.clear();
      for (const listener of [...closes]) listener(close);
      closes.clear();
      // alpd detaches a connection that went away: an idle root nobody watches is closed.
      for (const root of connection.attached) this.#reap(root);
    };
    connection.deliver = frame => { if (!ended) queueMicrotask(() => { for (const listener of [...messages]) listener(frame); }); };
    connection.end = end;
    connection.transport = {
      get state() { return ended ? 'closed' : 'open'; },
      send: frame => {
        if (ended) throw new Error('closed');
        const message = JSON.parse(frame);
        queueMicrotask(() => { if (!ended) void this.#handle(connection, message); });
      },
      onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
      onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
      close: () => end({ code: 1000 }),
    };
    this.connections.add(connection);
    return connection.transport;
  }

  /** Drops every connection as a gateway restart or a network cut would. */
  drop() { for (const connection of [...this.connections]) connection.end({ code: 1006, error: new Error('dropped') }); }

  #send(connection, message) { connection.deliver(JSON.stringify({ jsonrpc: '2.0', ...message })); }

  async #handle(connection, { id, method, params = {} }) {
    this.calls.push({ method, params });
    const answer = result => this.#send(connection, { id, result });
    const fail = (code, message, data) => this.#send(connection, { id, error: { code, message, ...(data ? { data } : {}) } });
    const hook = this.intercept.get(method);
    if (hook) {
      const verdict = await hook(params, connection, { answer, fail });
      if (verdict === 'handled') return;
    }
    try {
      const result = await this.#run(connection, method, params);
      if (result === undefined) return;
      answer(result);
    } catch (error) {
      fail(error.code ?? 1000, error.message, error.data);
    }
  }

  // ---- the daemon ----

  root(id) { return this.roots.get(id); }

  /** Creates a root with no viewer, as a session a local client started. */
  seed(id, { projectRoot = '/w/a', title, status = 'idle', mode = 'full-access' } = {}) {
    const root = this.#newRoot(id, { cwd: projectRoot, mode });
    if (title) root.summary.title = title;
    this.#emit(root, id, { type: 'session.opened', session: this.#snapshot(root, id), cwd: projectRoot, effective: { model: 'm', thinking: 'low' } });
    this.#emit(root, id, { type: 'session.ready' });
    if (status === 'closed') this.close(id);
    return root;
  }

  #newRoot(id, spec) {
    const root = { id, cursor: 0, timeline: [], live: true, viewers: new Set(), spec, children: new Map(), running: undefined, turns: 0, summary: { id, projectRoot: spec.cwd, agent: 'main', runtime: 'codex', model: 'm', mode: spec.mode ?? 'full-access', thinking: 'low', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: `t-${id}`, persistent: true, busy: false, status: 'idle', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString() } };
    this.roots.set(id, root);
    return root;
  }

  #snapshot(root, sessionId) {
    if (sessionId === root.id) return { ...root.summary, busy: !!root.running };
    return root.children.get(sessionId);
  }

  /** Appends a kept event to a root's timeline and sends it to its viewers. */
  #emit(root, sessionId, event, { kept = true } = {}) {
    const envelope = { sessionId, epoch: this.epoch, seq: root.timeline.length + 1, ts: new Date().toISOString(), event, ...(kept ? { cursor: ++root.cursor } : {}) };
    if (kept) root.timeline.push(envelope);
    for (const connection of root.viewers) this.#send(connection, { method: 'event', params: envelope });
    return envelope;
  }

  /** Emits an event as the host would while a turn runs. */
  emit(rootId, sessionId, event) { return this.#emit(this.roots.get(rootId), sessionId, event); }

  openChild(rootId, childId, agent = 'peer') {
    const root = this.roots.get(rootId);
    const snapshot = { ...root.summary, id: childId, agent, parentId: rootId, busy: true };
    root.children.set(childId, snapshot);
    this.#emit(root, childId, { type: 'session.opened', session: snapshot, cwd: root.spec.cwd, effective: { model: 'm', thinking: 'low' } });
  }

  ask(rootId, sessionId, questionId, body = 'Go on?') {
    const question = { id: questionId, sessionId, rootId, agent: 'main', body, options: ['yes', 'no'], askedAt: new Date().toISOString() };
    this.questions.set(questionId, question);
    const root = this.roots.get(rootId);
    for (const connection of root.viewers) this.#send(connection, { method: 'event', params: { sessionId, epoch: this.epoch, seq: 0, ts: question.askedAt, event: { type: 'question', question } } });
  }

  close(rootId) {
    const root = this.roots.get(rootId);
    if (!root.live) return;
    root.live = false;
    root.summary.status = 'closed';
    root.running = undefined;
    this.#emit(root, rootId, { type: 'session.closed' });
  }

  #reap(rootId) {
    const root = this.roots.get(rootId);
    if (!root) return;
    for (const connection of [...root.viewers]) if (!this.connections.has(connection)) root.viewers.delete(connection);
    if (root.viewers.size === 0 && !root.running && root.live) this.close(rootId);
  }

  #attach(connection, root) {
    root.viewers.add(connection);
    connection.attached.add(root.id);
  }

  finishTurn(rootId, text = 'done') {
    const root = this.roots.get(rootId);
    const turnId = root.running;
    if (!turnId) return;
    this.#emit(root, rootId, { type: 'item', item: { kind: 'assistant_message', id: `msg-${turnId}`, text } });
    root.running = undefined;
    root.summary.busy = false;
    this.#emit(root, rootId, { type: 'turn.ended', turnId, state: 'completed' });
  }

  async #run(connection, method, params) {
    switch (method) {
      case 'daemon.hello': return { protocolVersion: 1, daemonVersion: '0.10.0', capabilities: this.capabilities };
      case 'catalog.get': return { models: [], modes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'full-access' }], defaultModel: 'm' };
      case 'team.list': return { projectRoot: params.projectRoot, teams: [{ id: 'pho', label: 'Phở', source: 'builtin' }, { id: 'cafe', label: 'Cafe', source: 'builtin' }] };
      case 'library.models': return { models: [{ id: 'codex:gpt-5.6-sol', label: 'GPT', efforts: [] }] };
      case 'settings.language.get': return { language: null, applies: 'Vietnamese', default: 'Vietnamese' };
      case 'session.list': {
        const sessions = [...this.roots.values()].filter(root => !params.projectRoot || root.spec.cwd === params.projectRoot).map(root => ({ ...root.summary, busy: !!root.running }));
        return { sessions };
      }
      case 'session.create': {
        const existing = this.roots.get(params.sessionId);
        if (existing?.live) { this.#attach(connection, existing); return { session: this.#snapshot(existing, existing.id), attached: true }; }
        if (existing) {
          if (!params.resume) throw Object.assign(new Error('exists'), { code: 1000 });
          this.#attach(connection, existing);
          existing.live = true;
          existing.summary.status = 'idle';
          this.#emit(existing, existing.id, { type: 'session.opened', session: this.#snapshot(existing, existing.id), cwd: existing.spec.cwd, effective: { model: 'm', thinking: 'low' } });
          return { session: this.#snapshot(existing, existing.id), attached: false, resumed: true };
        }
        if (params.resume) throw Object.assign(new Error('gone'), { code: 1001 });
        const root = this.#newRoot(params.sessionId, params.spec);
        this.#attach(connection, root);
        this.#emit(root, root.id, { type: 'session.opened', session: this.#snapshot(root, root.id), cwd: params.spec.cwd, effective: { model: 'm', thinking: 'low' } });
        this.#emit(root, root.id, { type: 'session.ready' });
        return { session: this.#snapshot(root, root.id), attached: false };
      }
      case 'session.attach': {
        const root = this.roots.get(params.sessionId);
        if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
        const after = params.after ?? 0;
        const tip = root.cursor;
        const reset = params.after !== undefined && after > tip;
        const from = reset ? 0 : after;
        this.#attach(connection, root);
        for (const envelope of root.timeline) if (envelope.cursor > from) this.#send(connection, { method: 'event', params: envelope });
        for (const question of this.questions.values()) if (question.rootId === root.id) this.#send(connection, { method: 'event', params: { sessionId: question.sessionId, epoch: 'announce', seq: 0, ts: question.askedAt, event: { type: 'question', question } } });
        return { session: { ...root.summary, busy: !!root.running }, cursor: tip, ...(reset ? { reset: true } : {}) };
      }
      case 'session.release': {
        const root = this.roots.get(params.sessionId);
        if (!root) return { closed: false };
        root.viewers.delete(connection);
        connection.attached.delete(root.id);
        const was = root.live;
        this.#reap(root.id);
        return { closed: was && !root.live };
      }
      case 'session.prompt': {
        const root = this.roots.get(params.sessionId);
        if (!root?.live) throw Object.assign(new Error(`ALP session ${params.sessionId} is not open`), { code: 1001 });
        const key = `${params.sessionId}:${params.clientMessageId}`;
        if (this.receipts.has(key)) return { ...this.receipts.get(key), duplicate: true };
        const text = params.content.map(part => part.text).join('\n');
        if (params.delivery === 'steer' && !root.running) { const outcome = { outcome: 'failed', error: { message: 'No active turn to steer' }, durable: true }; this.receipts.set(key, outcome); return outcome; }
        if (params.delivery !== 'steer' && root.running) { const outcome = { outcome: 'failed', error: { message: 'Turn already active; use steering or interrupt first' }, durable: true }; this.receipts.set(key, outcome); return outcome; }
        const outcome = { outcome: 'accepted', durable: true };
        this.receipts.set(key, outcome);
        this.#emit(root, root.id, { type: 'item', item: { kind: 'user_message', id: `u-${params.clientMessageId}`, text, clientMessageId: params.clientMessageId } });
        if (params.delivery !== 'steer') {
          const turnId = `turn-${++root.turns}`;
          root.running = turnId;
          root.summary.busy = true;
          this.#emit(root, root.id, { type: 'prompt.accepted', clientMessageId: params.clientMessageId, result: 'turn', turnId });
          this.#emit(root, root.id, { type: 'turn.started', turnId, origin: 'user' });
          if (!text.includes('[hold]')) queueMicrotask(() => this.finishTurn(root.id, `echo: ${text}`));
        }
        return outcome;
      }
      case 'session.interrupt': {
        const root = this.roots.get(params.sessionId);
        if (root?.running) {
          const turnId = root.running;
          root.running = undefined;
          this.#emit(root, root.id, { type: 'turn.ended', turnId, state: 'canceled' });
        }
        return {};
      }
      case 'session.rename': {
        const root = this.roots.get(params.sessionId);
        root.summary.title = params.title;
        return { session: root.summary };
      }
      case 'session.archive': {
        const root = this.roots.get(params.sessionId);
        root.summary.archived = true;
        this.close(root.id);
        return { session: root.summary };
      }
      case 'question.answer': {
        const question = this.questions.get(params.questionId);
        if (!question) throw Object.assign(new Error('no such question'), { code: 1001 });
        this.questions.delete(params.questionId);
        const root = this.roots.get(question.rootId);
        for (const viewer of root.viewers) this.#send(viewer, { method: 'event', params: { sessionId: question.sessionId, epoch: this.epoch, seq: 0, ts: new Date().toISOString(), event: { type: 'question.resolved', questionId: question.id, outcome: params.dismiss ? 'dismissed' : 'answered', ...(params.text ? { answer: params.text } : {}) } } });
        return { questionId: question.id };
      }
      case 'task.list': return { projectRoot: params.projectRoot, tasks: structuredClone(this.tasks), unreadable: [], revision: `r${this.taskRev}` };
      case 'task.create': {
        const task = { id: `T${this.tasks.length + 1}`, title: params.title, type: 'task', priority: params.priority ?? 2, status: 'open', rev: 1, ready: true, updatedAt: new Date().toISOString() };
        this.tasks.push(task);
        this.taskRev++;
        return { id: task.id };
      }
      case 'task.update': case 'task.gate.resolve': {
        const task = this.tasks.find(entry => entry.id === params.id);
        if (!task) throw Object.assign(new Error('unknown task'), { code: 1001, data: { reason: 'unknown_task' } });
        if (params.ifRev !== undefined && params.ifRev !== task.rev) throw Object.assign(new Error('changed'), { code: 1004, data: { reason: 'revision_conflict' } });
        if (method === 'task.gate.resolve') { task.approvals = (task.approvals ?? []).filter(approval => approval.gate !== params.gate); if (!task.approvals.length) delete task.approvals; }
        else task.status = params.action === 'close' ? 'closed' : 'open';
        task.rev++;
        this.taskRev++;
        return { id: task.id, status: task.status, rev: task.rev };
      }
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
    }
  }
}

/** Waits until `check` holds, polling through microtasks and short timers. */
export async function until(check, what = 'condition', ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`${what} never happened`);
}
