// A gateway + alpd stand-in for the controller's unit tests: real JSON-RPC frames over an
// in-memory transport, a per-root stored timeline with cursors (§8), replay before the attach
// answer, idle roots closed when nobody watches, prompt receipts, tasks with revisions. Tests drop
// connections and fail requests at chosen points to prove the recovery rules.

export class FakeHost {
  /**
   * @param {{ principal?: any, separateTasks?: boolean, promptTiming?: { gapMs?: number, gate?: Promise<void>, answer: 'before' | 'middle' | 'after' } }} [options]
   *   separateTasks: each frame reaches the client in a task of its own, as a browser WebSocket
   *   delivers messages (no microtask run of several events in a row).
   *   promptTiming: a prompt's user message, then `gapMs` later prompt.accepted and turn.started,
   *   with its answer before, between or after those events.
   */
  constructor({ principal, separateTasks = false, promptTiming } = {}) {
    this.separateTasks = separateTasks;
    this.promptTiming = promptTiming;
    this.principal = principal ?? { id: 'p1', label: 'tests', permissions: ['session.read', 'session.write', 'project.read', 'project.write'], workspaces: ['/w/a', '/w/b'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }, { path: '/w/b', canonical: '/w/b' }] };
    this.capabilities = ['session.interrupt.turn', 'attach.after', 'prompt.receipts', 'task', 'team', 'library', 'settings.language'];
    /** @type {Map<string, any>} */
    this.roots = new Map();
    this.connections = new Set();
    this.calls = [];
    this.opens = 0;
    this.refuse = undefined;
    /** method → handler(params, connection) run before the default; return undefined to go on. */
    this.intercept = new Map();
    /** Methods whose next answer is lost: run, then the asking connection drops. @type {Set<string>} */
    this.loseAnswer = new Set();
    this.receipts = new Map();
    this.tasks = [];
    this.taskRev = 0;
    this.questions = new Map();
    this.epoch = 'e1';
    /** projectRoot → relative file paths, for workspace.files.search (capability workspace.files). */
    this.files = new Map();
    /**
     * projectRoot → { relative path → node }, for workspace.files.list / read (capability
     * workspace.files.read, permission files.read). A node: { kind: 'file' | 'directory', content?,
     * size?, modifiedAt?, binary?, tooLarge?, ignored?, linked?, blocked? }; directories are implied
     * by their files' paths too.
     */
    this.tree = new Map();
  }

  /** The entries of directory `directory` ('' the root) of a project's tree. */
  #listTree(projectRoot, directory) {
    const nodes = this.tree.get(projectRoot) ?? {};
    const prefix = directory ? `${directory}/` : '';
    const found = new Map();
    for (const [path, node] of Object.entries(nodes)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const [name, ...deeper] = rest.split('/');
      const child = `${prefix}${name}`;
      if (deeper.length) { if (!found.has(child)) found.set(child, { name, path: child, kind: 'directory', node: nodes[child] ?? {} }); continue; }
      found.set(child, { name, path: child, kind: node.kind ?? 'file', node });
    }
    return [...found.values()];
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
    const connection = { attached: new Set(), watching: undefined, watchTurns: false, watchAttention: false, transport: undefined, deliver: undefined, end: undefined };
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
    connection.deliver = frame => {
      if (ended) return;
      const run = () => { if (!ended) for (const listener of [...messages]) listener(frame); };
      if (this.separateTasks) setTimeout(run, 0); else queueMicrotask(run);
    };
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
      const result = await this.#run(connection, method, params, id);
      // Taken, but this connection drops before the answer leaves (a lost answer).
      if (this.loseAnswer?.delete(method)) { connection.end({ code: 1006, error: new Error('dropped') }); return; }
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
    const root = { id, cursor: 0, timeline: [], generation: `gen-${id}-1`, branches: [], live: true, viewers: new Set(), spec, children: new Map(), running: undefined, turns: 0, summary: { id, projectRoot: spec.cwd, agent: 'main', runtime: 'codex', model: 'm', mode: spec.mode ?? 'full-access', thinking: 'low', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: `t-${id}`, persistent: true, busy: false, status: 'idle', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString() } };
    this.roots.set(id, root);
    return root;
  }

  #snapshot(root, sessionId) {
    if (sessionId === root.id) return { ...root.summary, busy: !!root.running };
    return root.children.get(sessionId);
  }

  /**
   * With session.attention, as alpd: a root's attention kept for every client, told (no cursor) to
   * the connections watching attention in its project, attached or not.
   */
  #setAttention(root, attention) {
    if (!this.capabilities.includes('session.attention') || (!root.summary.attention && !attention)) return;
    if (attention) root.summary.attention = attention; else delete root.summary.attention;
    const envelope = { sessionId: root.id, epoch: 'attention', seq: 0, ts: new Date().toISOString(), event: { type: 'attention', ...(attention ? { attention } : {}) } };
    for (const connection of this.connections) {
      if (!connection.watchAttention) continue;
      if (connection.watching !== null && connection.watching !== root.spec.cwd) continue;
      this.#send(connection, { method: 'event', params: envelope });
    }
  }

  /** Appends a kept event to a root's timeline and sends it to its viewers. */
  #emit(root, sessionId, event, { kept = true } = {}) {
    const envelope = { sessionId, epoch: this.epoch, seq: root.timeline.length + 1, ts: new Date().toISOString(), event, ...(kept ? { cursor: ++root.cursor } : {}) };
    if (kept) root.timeline.push(envelope);
    for (const connection of root.viewers) this.#send(connection, { method: 'event', params: envelope });
    if (sessionId === root.id && event.type === 'turn.started') this.#setAttention(root, undefined);
    if (sessionId === root.id && event.type === 'turn.ended') {
      const at = new Date(Date.now() + (this.attentionSkewMs ?? 0)).toISOString();
      this.#setAttention(root, event.state === 'canceled' ? undefined : { reason: event.state === 'completed' ? 'finished' : 'error', at, turnId: event.turnId, ...(event.state === 'failed' && event.error?.message ? { message: event.error.message } : {}) });
    }
    // question.watch { turns: true }: a root's turn end goes, without its cursor, to the watchers
    // of its project that are not attached to its tree.
    if (event.type === 'turn.ended' && sessionId === root.id) {
      const { cursor: _cursor, ...copy } = envelope;
      for (const connection of this.connections) {
        if (connection.watching === undefined || !connection.watchTurns || root.viewers.has(connection)) continue;
        if (connection.watching !== null && connection.watching !== root.spec.cwd) continue;
        this.#send(connection, { method: 'event', params: copy });
      }
    }
    return envelope;
  }

  /** A turn of a root nobody watches starts (as a local client's prompt would). */
  startTurn(rootId) {
    const root = this.roots.get(rootId);
    const turnId = `turn-${++root.turns}`;
    root.running = turnId;
    root.summary.busy = true;
    this.#emit(root, rootId, { type: 'turn.started', turnId, origin: 'user' });
    return turnId;
  }

  /** Ends the running turn of a root as `state` ('completed' | 'failed' | 'canceled'). */
  endTurn(rootId, state = 'completed', error) {
    const root = this.roots.get(rootId);
    const turnId = root.running;
    if (!turnId) return;
    root.running = undefined;
    root.summary.busy = false;
    this.#emit(root, rootId, { type: 'turn.ended', turnId, state, ...(error ? { error } : {}) });
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
    this.#tell(root, { sessionId, epoch: this.epoch, seq: 0, ts: question.askedAt, event: { type: 'question', question } });
  }

  /** A question event to the tree's viewers, and as alpd's question.watch to the watchers of its project (no cursor). */
  #tell(root, envelope) {
    for (const connection of root.viewers) this.#send(connection, { method: 'event', params: envelope });
    const { cursor: _cursor, ...announced } = envelope;
    for (const connection of this.connections) {
      if (connection.watching === undefined || root.viewers.has(connection)) continue;
      if (connection.watching !== null && connection.watching !== root.spec.cwd) continue;
      this.#send(connection, { method: 'event', params: announced });
    }
  }

  /** A question answered or ended elsewhere: question.resolved to the viewers and watchers. */
  resolve(questionId, outcome = 'answered', answer) {
    const question = this.questions.get(questionId);
    if (!question) return;
    this.questions.delete(questionId);
    this.#tell(this.roots.get(question.rootId), { sessionId: question.sessionId, epoch: this.epoch, seq: 0, ts: new Date().toISOString(), event: { type: 'question.resolved', questionId, outcome, ...(answer ? { answer } : {}) } });
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

  /** The root's turns in timeline order, each with the cursor its first line has (§12.7). */
  #turns(root) {
    const prompts = new Map();
    const turns = [];
    for (const envelope of root.timeline) {
      if (envelope.sessionId !== root.id) continue;
      const event = envelope.event;
      if (event.type === 'item' && event.item.kind === 'user_message' && event.item.clientMessageId) prompts.set(event.item.clientMessageId, envelope.cursor);
      else if ((event.type === 'prompt.accepted' && event.result === 'turn') || event.type === 'turn.started') {
        if (turns.some(turn => turn.id === event.turnId)) continue;
        turns.push({ id: event.turnId, start: event.type === 'prompt.accepted' ? Math.min(prompts.get(event.clientMessageId) ?? envelope.cursor, envelope.cursor) : envelope.cursor });
      } else if (event.type === 'turn.ended') { const turn = turns.find(candidate => candidate.id === event.turnId); if (turn) turn.ended = true; }
    }
    return turns;
  }

  /** A journaled answer per (session, operation, requestId), as alpd's lifecycle journal. */
  #journaled(key, fingerprint, run) {
    this.lifecycle ??= new Map();
    const known = this.lifecycle.get(key);
    if (known) {
      if (known.fingerprint !== fingerprint) throw Object.assign(new Error('key conflict'), { code: 1004, data: { reason: 'key_conflict' } });
      return { ...known.result, duplicate: true };
    }
    const result = run();
    this.lifecycle.set(key, { fingerprint, result });
    return result;
  }

  /** session.reload (§12.8): a live idle root restarts; its timeline, receipts and generation stay. */
  #reload(params) {
    if (!this.capabilities.includes('session.reload')) throw Object.assign(new Error('unknown method session.reload'), { code: -32601 });
    const root = this.roots.get(params.sessionId);
    if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
    return this.#journaled(`${root.id}:reload:${params.requestId}`, 'reload', () => {
      if (this.reloadError) throw this.reloadError;
      if (root.running) throw Object.assign(new Error('busy'), { code: 1004, data: { reason: 'session_busy' } });
      if (params.ifGeneration !== root.generation) throw Object.assign(new Error('stale'), { code: 1004, data: { reason: 'stale_generation' } });
      if (!root.live) throw Object.assign(new Error('closed'), { code: 1005, data: { reason: 'session_closed' } });
      this.reloads = (this.reloads ?? 0) + 1;
      return { session: { ...root.summary } };
    });
  }

  /** Teams a live configure may switch to (§12.9): id → { label, agent, runtime }. */
  configureTeams = { pho: { label: 'Phở', agent: 'main' }, cafe: { label: 'Cafe', agent: 'main' }, solo: { label: 'Solo', agent: 'builder' } };
  /** Models the host offers a live root, per runtime, with the efforts each takes. */
  configureModels = { codex: { m: ['low', 'high'], 'gpt-5.6-sol': ['low', 'medium', 'high'] }, claude: { 'claude-haiku-4-5': [] } };

  /** What a change would run a live root with, or a refusal reason (§12.9). */
  #resolveConfigure(root, params) {
    const summary = root.summary;
    const current = { team: summary.workflow.mode, teamLabel: summary.teamLabel ?? this.configureTeams[summary.workflow.mode]?.label, agent: summary.agent, runtime: summary.runtime, model: summary.model, thinking: summary.thinking, mode: summary.mode, supervisor: false, maxPeers: 2, delegates: [], tools: [], mcpServers: [], hooks: 0 };
    const proposed = { ...current };
    let refusal;
    if (params.model !== undefined) {
      const match = /^(codex|claude|acp|antigravity)[:/](.*)$/.exec(params.model);
      if (match && match[1] !== summary.runtime) refusal = 'runtime_mismatch';
      else if (!this.configureModels[summary.runtime]?.[match ? match[2] : params.model]) refusal = 'invalid_params';
      else proposed.model = match ? match[2] : params.model;
    }
    if (!refusal && params.team !== undefined) {
      const team = this.configureTeams[params.team];
      if (!team) refusal = 'team_not_found';
      else if (team.agent !== summary.agent) refusal = 'agent_mismatch';
      else Object.assign(proposed, { team: params.team, teamLabel: team.label });
    }
    const efforts = this.configureModels[summary.runtime]?.[proposed.model] ?? [];
    if (!refusal && params.thinking !== undefined) {
      if (!efforts.includes(params.thinking)) refusal = 'invalid_params';
      else proposed.thinking = params.thinking;
    } else if (!refusal && !efforts.includes(proposed.thinking)) proposed.thinking = efforts[0] ?? proposed.thinking;
    const changes = ['model', 'thinking', 'team', 'mode'].filter(key => current[key] !== proposed[key]);
    return { current, proposed, changes, refusal };
  }

  #configurePreview(params) {
    if (!this.capabilities.includes('session.configure.live')) throw Object.assign(new Error('unknown method session.configure.preview'), { code: -32601 });
    const root = this.roots.get(params.sessionId);
    if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
    if (!root.live) throw Object.assign(new Error('closed'), { code: 1005, data: { reason: 'session_closed' } });
    const { current, proposed, changes, refusal } = this.#resolveConfigure(root, params);
    const busy = !refusal && changes.length && root.running ? 'session_busy' : undefined;
    const reason = refusal ?? busy;
    return { preview: { current, proposed, changes, restart: changes.some(change => change !== 'mode'), allowed: !reason, ...(reason ? { reason, message: `fixed ${reason}` } : {}), teams: Object.entries(this.configureTeams).map(([id, team]) => ({ id, label: team.label })) } };
  }

  /** session.configure with model, thinking or team (§12.9): a live idle root restarts with them, journaled per requestId. */
  #configureLive(params) {
    if (!this.capabilities.includes('session.configure.live')) throw Object.assign(new Error('mode only'), { code: 1005, data: { reason: 'capability' } });
    if (typeof params.requestId !== 'string' || typeof params.ifGeneration !== 'string') throw Object.assign(new Error('needs requestId and ifGeneration'), { code: -32602, data: { reason: 'invalid_params' } });
    if (params.team !== undefined && !this.principal.permissions.includes('session.team.write')) throw Object.assign(new Error('This credential lacks session.team.write'), { code: 1003, data: { reason: 'grant', permission: 'session.team.write' } });
    const root = this.roots.get(params.sessionId);
    if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
    const { requestId: _requestId, ifGeneration: _generation, sessionId: _sessionId, ...asked } = params;
    return this.#journaled(`${root.id}:configure:${params.requestId}`, JSON.stringify(asked), () => {
      if (this.configureError) throw this.configureError;
      if (!root.live) throw Object.assign(new Error('closed'), { code: 1005, data: { reason: 'session_closed' } });
      if (root.running || this.questions.size) throw Object.assign(new Error('busy'), { code: 1004, data: { reason: 'session_busy' } });
      if (params.ifGeneration !== root.generation) throw Object.assign(new Error('stale'), { code: 1004, data: { reason: 'stale_generation' } });
      const { proposed, changes, refusal } = this.#resolveConfigure(root, params);
      if (refusal === 'runtime_mismatch' || refusal === 'agent_mismatch') throw Object.assign(new Error(`refused: ${refusal} /secret/path`), { code: 1005, data: { reason: refusal, action: 'session.create' } });
      if (refusal === 'team_not_found') throw Object.assign(new Error('no team'), { code: 1001, data: { reason: refusal } });
      if (refusal) throw Object.assign(new Error('invalid'), { code: -32602, data: { reason: refusal } });
      this.configures = (this.configures ?? 0) + 1;
      if (changes.length) {
        Object.assign(root.summary, { model: proposed.model, thinking: proposed.thinking, teamLabel: proposed.teamLabel, workflow: { ...root.summary.workflow, mode: proposed.team } });
        const { status: _status, createdAt: _created, updatedAt: _updated, archived: _archived, ...snapshot } = root.summary;
        this.#emit(root, root.id, { type: 'session.updated', session: snapshot });
      }
      return { session: { ...root.summary }, configured: { status: changes.length ? 'applied' : 'unchanged', requested: asked, effective: proposed, restarted: changes.length > 0 } };
    });
  }

  #rewind(params) {
    const root = this.roots.get(params.sessionId);
    if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
    return this.#journaled(`${root.id}:rewind:${params.requestId}`, params.beforeTurnId, () => {
      if (root.running) throw Object.assign(new Error('busy'), { code: 1004, data: { reason: 'session_busy' } });
      if (params.ifGeneration !== root.generation) throw Object.assign(new Error('stale'), { code: 1004, data: { reason: 'stale_generation' } });
      const turns = this.#turns(root);
      const index = turns.findIndex(turn => turn.id === params.beforeTurnId);
      if (index < 0) throw Object.assign(new Error('no turn'), { code: 1001, data: { reason: 'turn_not_found' } });
      if (index === 0) throw Object.assign(new Error('first'), { code: 1005, data: { reason: 'empty_prefix' } });
      const branchId = `br_${root.branches.length + 1}`;
      const branch = { branchId, beforeTurnId: params.beforeTurnId, turns: turns.length - index, at: new Date().toISOString() };
      root.setAside = [...(root.setAside ?? []), { branchId, timeline: root.timeline.slice() }];
      root.branches.push(branch);
      root.summary.branches = root.branches.slice();
      root.generation = `gen-${root.id}-${root.branches.length + 1}`;
      const marker = { sessionId: root.id, epoch: `rewind-${branchId}`, seq: 0, ts: branch.at, cursor: ++root.cursor, event: { type: 'item', item: { kind: 'notice', id: `rewind:${branchId}`, level: 'info', text: `Conversation rewound to before a message: ${branch.turns} later turns moved to a recoverable branch. Files were not changed.` } } };
      root.timeline = [...root.timeline.filter(envelope => envelope.cursor < turns[index].start), marker];
      for (const connection of root.viewers) {
        this.#send(connection, { method: 'event', params: { sessionId: root.id, epoch: `rewind-${branchId}`, seq: 0, ts: branch.at, event: { type: 'history.reset', generation: root.generation, reason: 'rewind', branchId } } });
        this.#send(connection, { method: 'event', params: marker });
      }
      return { session: { ...root.summary }, generation: root.generation, branch };
    });
  }

  #fork(params) {
    const root = this.roots.get(params.sessionId);
    if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
    return this.#journaled(`${root.id}:fork:${params.requestId}`, JSON.stringify([params.boundary ?? null, params.branchId ?? null, params.workspaceId ?? null, params.title ?? null]), () => {
      if (params.ifGeneration !== root.generation) throw Object.assign(new Error('stale'), { code: 1004, data: { reason: 'stale_generation' } });
      const source = params.branchId ? root.setAside?.find(entry => entry.branchId === params.branchId)?.timeline : root.timeline;
      if (!source) throw Object.assign(new Error('no branch'), { code: 1001, data: { reason: 'branch_not_found' } });
      const turns = this.#turns({ ...root, timeline: source });
      let cut = Infinity;
      if (params.boundary?.throughTurnId) {
        const index = turns.findIndex(turn => turn.id === params.boundary.throughTurnId);
        if (index < 0) throw Object.assign(new Error('no turn'), { code: 1001, data: { reason: 'turn_not_found' } });
        if (!turns[index].ended) throw Object.assign(new Error('running'), { code: 1004, data: { reason: 'turn_in_progress' } });
        cut = turns[index + 1]?.start ?? Infinity;
      }
      this.forks = (this.forks ?? 0) + 1;
      const id = `ses_fork_${this.forks}`;
      const fork = this.#newRoot(id, { cwd: params.workspaceId ? `/w/${params.workspaceId}` : root.spec.cwd, mode: root.spec.mode });
      const forkedFrom = { sessionId: root.id, ...(params.boundary?.throughTurnId ? { turnId: params.boundary.throughTurnId, boundary: 'through' } : { boundary: 'whole' }), ...(params.branchId ? { branchId: params.branchId } : {}), at: new Date().toISOString() };
      fork.timeline = source.filter(envelope => envelope.sessionId === root.id && envelope.cursor < cut).map(envelope => ({ ...envelope, sessionId: id }));
      fork.cursor = fork.timeline.at(-1)?.cursor ?? 0;
      fork.timeline.push({ sessionId: id, epoch: 'fork', seq: 0, ts: forkedFrom.at, cursor: ++fork.cursor, event: { type: 'item', item: { kind: 'notice', id: `fork:${id}`, level: 'info', text: 'Forked.' } } });
      fork.live = false;
      Object.assign(fork.summary, { status: 'closed', forkedFrom, conversation: root.summary.conversation, ...(params.title ? { title: params.title } : {}) });
      return { session: { ...fork.summary }, forkedFrom };
    });
  }

  async #run(connection, method, params, requestId) {
    switch (method) {
      case 'daemon.hello': return { protocolVersion: 1, daemonVersion: '0.10.0', capabilities: this.capabilities };
      case 'catalog.get': return { models: [], modes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'full-access' }], defaultModel: 'm' };
      case 'team.list': return { projectRoot: params.projectRoot, teams: [{ id: 'pho', label: 'Phở', source: 'builtin' }, { id: 'cafe', label: 'Cafe', source: 'builtin' }] };
      case 'library.models': return { models: [{ id: 'codex:gpt-5.6-sol', label: 'GPT', efforts: ['low', 'medium', 'high'], effort: 'low' }, { id: 'claude:claude-haiku-4-5', label: 'Haiku', efforts: [] }] };
      case 'session.preview': {
        const spec = params.spec ?? {};
        if (spec.thinking && spec.thinking !== 'low' && spec.thinking !== 'medium' && spec.thinking !== 'high') throw Object.assign(new Error(`thinking ${spec.thinking} is not offered`), { code: -32602 });
        const [runtime, model] = String(spec.model ?? 'codex:gpt-5.6-sol').split(':');
        return { preview: { teams: [{ id: 'pho', label: 'Phở' }, { id: 'cafe', label: 'Cafe' }], team: spec.workflow ?? 'pho', teamLabel: spec.workflow === 'cafe' ? 'Cafe' : 'Phở', agent: 'main', runtime, model, mode: spec.mode ?? 'full-access', thinking: spec.thinking ?? 'low' } };
      }
      case 'settings.language.get': return { language: null, applies: 'Vietnamese', default: 'Vietnamese' };
      case 'session.list': {
        const words = String(params.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        // A root `unlisted` is one session.list does not show yet (created a moment ago elsewhere).
        let sessions = [...this.roots.values()].filter(root => !root.unlisted && (!params.projectRoot || root.spec.cwd === params.projectRoot) && (params.includeArchived || !root.summary.archived)).map(root => ({ ...root.summary, busy: !!root.running }));
        // With session.list.page: newest first, the query, then a page; the cursor is a position here.
        if (!this.capabilities.includes('session.list.page')) return { sessions };
        sessions = sessions.filter(session => words.every(word => `${session.title ?? ''}\n${session.id}`.toLowerCase().includes(word)))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        const start = params.cursor === undefined ? 0 : Number(params.cursor.slice(1));
        const end = params.limit === undefined ? sessions.length : start + params.limit;
        return { sessions: sessions.slice(start, end), ...(end < sessions.length ? { nextCursor: `@${end}` } : {}) };
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
        if (params.generation !== undefined && params.generation !== root.generation) throw Object.assign(new Error('stale cursor'), { code: 1004, data: { reason: 'stale_cursor' } });
        const after = params.after ?? 0;
        const tip = root.cursor;
        const reset = params.after !== undefined && after > tip;
        const from = reset ? 0 : after;
        this.#attach(connection, root);
        for (const envelope of root.timeline) if (envelope.cursor > from) this.#send(connection, { method: 'event', params: envelope });
        for (const question of this.questions.values()) if (question.rootId === root.id) this.#send(connection, { method: 'event', params: { sessionId: question.sessionId, epoch: 'announce', seq: 0, ts: question.askedAt, event: { type: 'question', question } } });
        return { session: { ...root.summary, busy: !!root.running }, cursor: tip, ...(reset ? { reset: true } : {}) };
      }
      case 'session.history': {
        // The whole stored timeline as one page (capability session.history, §8.7).
        if (!this.capabilities.includes('session.history')) throw Object.assign(new Error('unknown method session.history'), { code: -32601 });
        const root = this.roots.get(params.sessionId);
        if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
        return { generation: root.generation, items: structuredClone(root.timeline), hasOlder: false, tipCursor: root.cursor };
      }
      case 'session.rewind': return this.#rewind(params);
      case 'session.reload': return this.#reload(params);
      case 'session.compact': {
        // t-de1a: an older host has no such method; this one answers started, or deferred while busy.
        if (this.compactUnknown) throw Object.assign(new Error('unknown method session.compact'), { code: -32601 });
        const root = this.roots.get(params.sessionId);
        if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
        if (this.compactError) throw this.compactError;
        this.compacts = (this.compacts ?? 0) + 1;
        return { status: root.running ? 'deferred' : 'started' };
      }
      case 'session.resumeCommand': {
        if (!this.capabilities.includes('session.resumeCommand')) throw Object.assign(new Error('unknown method session.resumeCommand'), { code: -32601 });
        if (!this.roots.has(params.sessionId) && ![...this.roots.values()].some(root => root.children?.some?.(child => child.id === params.sessionId))) throw Object.assign(new Error('no such session'), { code: 1001 });
        const line = `alp attach ${params.sessionId}`;
        return { argv: ['alp', 'attach', params.sessionId], posix: line, windows: line, display: line, platform: 'posix' };
      }
      case 'session.fork': return this.#fork(params);
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
        const steer = params.delivery === 'steer';
        const turnId = steer ? root.running : `turn-${++root.turns}`;
        if (!steer) { root.running = turnId; root.summary.busy = true; }
        const userMessage = () => {
          this.#emit(root, root.id, { type: 'item', item: { kind: 'user_message', id: `u-${params.clientMessageId}`, text, clientMessageId: params.clientMessageId } });
          // As alpd: the first message names an unnamed root, announced as session.updated.
          const line = text.split(/\r?\n/).map(entry => entry.replace(/\s+/g, ' ').trim()).find(Boolean);
          if (!root.summary.title && line) {
            root.summary.title = [...line].slice(0, 60).join('').trim();
            // A runtime snapshot plus the title, as alpd sends: no list-only fields.
            const { status: _status, createdAt: _created, updatedAt: _updated, archived: _archived, ...snapshot } = root.summary;
            this.#emit(root, root.id, { type: 'session.updated', session: snapshot });
          }
        };
        const accepted = () => {
          this.#emit(root, root.id, { type: 'prompt.accepted', clientMessageId: params.clientMessageId, result: steer ? 'steer' : 'turn', turnId });
          if (steer) return;
          this.#emit(root, root.id, { type: 'turn.started', turnId, origin: 'user' });
          if (!text.includes('[hold]')) queueMicrotask(() => this.finishTurn(root.id, `echo: ${text}`));
        };
        const timing = this.promptTiming;
        if (!timing) { userMessage(); accepted(); return outcome; }
        const gap = () => timing.gate ?? new Promise(resolve => setTimeout(resolve, timing.gapMs));
        const reply = () => this.#send(connection, { id: requestId, result: outcome });
        if (timing.answer === 'before') reply();
        userMessage();
        if (timing.answer === 'middle') reply();
        await gap();
        accepted();
        if (timing.answer === 'after') reply();
        return undefined;
      }
      case 'session.interrupt': {
        const root = this.roots.get(params.sessionId);
        if (params.turnId !== undefined && root?.running !== params.turnId) return { interrupted: false };
        if (root?.running) {
          const turnId = root.running;
          root.running = undefined;
          this.#emit(root, root.id, { type: 'turn.ended', turnId, state: 'canceled' });
        }
        return params.turnId !== undefined ? { interrupted: true } : {};
      }
      case 'session.configure.preview': return this.#configurePreview(params);
      case 'session.configure': {
        if (params.model !== undefined || params.thinking !== undefined || params.team !== undefined) return this.#configureLive(params);
        const root = this.roots.get(params.sessionId);
        if (!root?.live) throw Object.assign(new Error(`ALP session ${params.sessionId} is not open`), { code: 1001 });
        if (params.mode) root.summary.mode = params.mode;
        const session = { id: root.id, mode: root.summary.mode, busy: !!root.running };
        this.#emit(root, root.id, { type: 'session.updated', session });
        return { session };
      }
      case 'session.rename': {
        const root = this.roots.get(params.sessionId);
        root.summary.title = params.title;
        return { session: root.summary };
      }
      case 'session.archive': {
        const root = this.roots.get(params.sessionId);
        if (params.archived === false) { delete root.summary.archived; return { session: root.summary }; }
        root.summary.archived = true;
        this.#setAttention(root, undefined);
        this.close(root.id);
        return { session: root.summary };
      }
      case 'question.list': {
        const questions = [...this.questions.values()].filter(question => !params.projectRoot || this.roots.get(question.rootId)?.spec.cwd === params.projectRoot);
        return { questions: structuredClone(questions) };
      }
      case 'question.watch': {
        connection.watching = params.projectRoot ?? null;
        connection.watchTurns = this.capabilities.includes('question.watch.turns') && params.turns === true;
        const shared = this.capabilities.includes('session.attention') && params.attention === true;
        connection.watchAttention = shared;
        const questions = [...this.questions.values()].filter(question => !params.projectRoot || this.roots.get(question.rootId)?.spec.cwd === params.projectRoot);
        const attention = [...this.roots.values()].filter(root => root.summary.attention && (!params.projectRoot || root.spec.cwd === params.projectRoot)).map(root => ({ sessionId: root.id, attention: structuredClone(root.summary.attention) }));
        return { questions: structuredClone(questions), ...(shared ? { attention } : {}) };
      }
      case 'session.attention.clear': {
        if (!this.capabilities.includes('session.attention')) throw Object.assign(new Error('unknown method session.attention.clear'), { code: -32601 });
        const root = this.roots.get(params.sessionId);
        if (!root) throw Object.assign(new Error('no such session'), { code: 1001 });
        const attention = root.summary.attention;
        if (!attention || (params.at !== undefined && attention.at !== params.at)) return { cleared: false };
        this.#setAttention(root, undefined);
        return { cleared: true };
      }
      case 'question.answer': {
        const question = this.questions.get(params.questionId);
        if (!question) throw Object.assign(new Error('no such question'), { code: 1001 });
        this.resolve(question.id, params.dismiss ? 'dismissed' : 'answered', params.text);
        return { questionId: question.id };
      }
      case 'workspace.files.search': {
        if (!this.capabilities.includes('workspace.files')) throw Object.assign(new Error('unknown method workspace.files.search'), { code: -32601 });
        if (!this.principal.permissions.includes('project.read')) throw Object.assign(new Error('forbidden'), { code: 1003 });
        const query = String(params.query ?? '').toLowerCase();
        const all = (this.files.get(params.projectRoot) ?? []).filter(path => path.toLowerCase().includes(query));
        const limit = params.limit ?? 30;
        return { files: all.slice(0, limit).map(path => ({ path })), ...(all.length > limit ? { truncated: true } : {}) };
      }
      case 'workspace.files.list': case 'workspace.files.read': {
        if (!this.capabilities.includes('workspace.files.read')) throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
        if (!this.principal.permissions.includes('files.read')) throw Object.assign(new Error('The credential is not allowed this method.'), { code: 1003, data: { reason: 'grant', permission: 'files.read' } });
        const path = params.path ?? '';
        const refuse = (code, reason) => { throw Object.assign(new Error(`refused: ${reason}`), { code, data: { reason } }); };
        if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) refuse(-32602, 'invalid_path');
        const nodes = this.tree.get(params.projectRoot) ?? {};
        const node = nodes[path];
        if (node?.blocked || /(^|\/)(\.env[^/]*|\.git|\.alp)(\/|$)/.test(path)) refuse(1003, 'blocked_path');
        if (node?.linked) refuse(1003, 'linked');
        if (node?.ignored && !params.includeIgnored) refuse(1003, 'ignored');
        if (method === 'workspace.files.list') {
          if (path && !this.#listTree(params.projectRoot, path).length && node?.kind !== 'directory') refuse(1001, 'not_found');
          const entries = this.#listTree(params.projectRoot, path)
            .filter(entry => !entry.node.blocked && !entry.node.linked && (params.includeIgnored || !entry.node.ignored))
            .sort((a, b) => a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name < b.name ? -1 : 1)
            .map(({ node: entryNode, ...entry }) => ({ ...entry, ...(entry.kind === 'file' ? { size: entryNode.size ?? (entryNode.content ?? '').length } : {}), ...(entryNode.modifiedAt ? { modifiedAt: entryNode.modifiedAt } : {}) }));
          return { entries, ...(this.extraEntries ? { entries: [...entries, ...this.extraEntries] } : {}) };
        }
        if (!node || node.kind === 'directory') refuse(1001, 'not_found');
        if (node.binary) refuse(1000, 'binary');
        if (node.tooLarge) refuse(1000, 'too_large');
        return { path, content: node.content ?? '', size: node.size ?? (node.content ?? '').length, ...(node.modifiedAt ? { modifiedAt: node.modifiedAt } : {}) };
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
