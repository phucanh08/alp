// An in-memory stand-in for alpd behind the gateway's upstream: each open() is one daemon
// connection (an AlpTransport, as the client SDK's connectSocket returns). It answers the v1 methods
// the gateway forwards from fixture sessions and questions, records every request it receives
// (to prove refused requests reach nothing), keeps per-connection attachments and emits events
// to the connections attached to a tree, with cursors, as alpd does. The end-to-end test against
// a real alpd is test/integration/gateway.test.js.

/** A session summary in `projectRoot`. @param {string} id @param {string} projectRoot @param {Record<string, unknown>} [extra] */
export function summary(id, projectRoot, extra = {}) {
  return { id, projectRoot, agent: 'main', runtime: 'codex', model: 'gpt', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: `t-${id}`, persistent: true, busy: false, status: 'idle', ...extra };
}

const error = (code, message, data) => ({ code, message, ...(data ? { data } : {}) });

/**
 * @param {{ sessions?: object[], questions?: object[], capabilities?: string[] }} [fixture]
 */
export function fakeDaemon({ sessions = [], questions = [], capabilities = ['attach.after', 'extension.methods', 'prompt.receipts', 'task', 'team', 'library', 'library.project.write', 'settings.language', 'session.list.page', 'question.watch', 'question.watch.turns', 'workspace.files', 'workspace.files.read'] } = {}) {
  const state = {
    /** @type {Map<string, any>} */ sessions: new Map(sessions.map(session => [session.id, session])),
    questions: [...questions],
    /** Every request a daemon connection received: { link, method, params }. */
    calls: /** @type {Array<{ link: number, method: string, params: any }>} */ ([]),
    /** Kept envelopes per root. */
    timelines: /** @type {Map<string, any[]>} */ (new Map()),
    /** Overrides: method → (params, link) => result | Promise; throw { code, message, data } for errors. */
    handlers: /** @type {Record<string, Function>} */ ({}),
    links: /** @type {Set<any>} */ (new Set()),
    /** Tasks per projectRoot. */
    tasks: /** @type {Map<string, any[]>} */ (new Map()),
    /** File paths per projectRoot, for workspace.files.search. */
    files: /** @type {Map<string, string[]>} */ (new Map()),
    opened: 0,
    refuse: false,
  };
  let nextLink = 0;

  const rootOf = id => {
    let current = state.sessions.get(id);
    for (let depth = 0; current?.parentId && depth < 64; depth++) current = state.sessions.get(current.parentId);
    return current?.id ?? id;
  };

  /** Keeps an event in its tree's timeline and sends it to the connections attached to the tree. */
  function emit(sessionId, event, { keep = true } = {}) {
    const root = rootOf(sessionId);
    const timeline = state.timelines.get(root) ?? [];
    const envelope = { sessionId, epoch: 'e1', seq: timeline.length + 1, ts: new Date().toISOString(), event, ...(keep ? { cursor: timeline.length + 1 } : {}) };
    if (keep) timeline.push(envelope);
    state.timelines.set(root, timeline);
    for (const link of state.links) if (link.attached.has(root)) link.send({ jsonrpc: '2.0', method: 'event', params: envelope });
    // question.watch: the trees a connection is not attached to, without the cursor, as alpd does.
    // With turns, also a root's turn.ended.
    if (event.type === 'question' || event.type === 'question.resolved' || (event.type === 'turn.ended' && root === sessionId)) {
      const { cursor: _cursor, ...announced } = envelope;
      for (const link of state.links) if (link.watching && (event.type !== 'turn.ended' || link.watching.turns) && !link.attached.has(root) && (link.watching.projectRoot === undefined || state.sessions.get(root)?.projectRoot === link.watching.projectRoot)) link.send({ jsonrpc: '2.0', method: 'event', params: announced });
    }
    return envelope;
  }

  const builtins = {
    'daemon.hello': () => ({ protocolVersion: 1, daemonVersion: 'fake', pid: 4242, hostname: 'fake-host', capabilities }),
    'daemon.status': () => ({ pid: 4242, startedAt: new Date().toISOString(), version: 'fake', protocolVersion: 1, sessions: state.sessions.size, questions: state.questions.length, health: { live: true, ready: true, checks: [] } }),
    'catalog.get': () => ({ models: [], modes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'full-access' }], defaultModel: 'codex:gpt' }),
    'session.get': ({ sessionId }) => {
      const found = state.sessions.get(sessionId);
      if (!found) throw error(1001, 'Session is not open');
      return { session: found };
    },
    // Pages by position: the cursor is the index of the next session.
    'session.list': ({ projectRoot, projectRoots, limit, cursor, query }) => {
      const all = [...state.sessions.values()].filter(session => (projectRoot === undefined || session.projectRoot === projectRoot) && (projectRoots === undefined || projectRoots.includes(session.projectRoot)) && (query === undefined || `${session.title ?? ''}\n${session.id}`.includes(query)));
      const start = cursor === undefined ? 0 : Number(cursor.slice(1));
      const end = limit === undefined ? all.length : start + limit;
      return { sessions: all.slice(start, end), ...(end < all.length ? { nextCursor: `@${end}` } : {}) };
    },
    'session.status': ({ sessionId }) => ({ status: { rootId: rootOf(sessionId), sessions: [], assignments: [], questions: [], worktrees: [] } }),
    'session.log': ({ sessionId }) => ({ rootId: rootOf(sessionId), entries: [] }),
    'session.attach': ({ sessionId, replay = true, after }, link) => {
      if (!state.sessions.has(sessionId)) throw error(1001, 'Session is not open');
      const root = rootOf(sessionId);
      const timeline = state.timelines.get(root) ?? [];
      const tip = timeline.at(-1)?.cursor ?? 0;
      const reset = after !== undefined && after > tip;
      if (replay) for (const envelope of timeline) if (envelope.cursor > (reset ? 0 : after ?? 0)) link.send({ jsonrpc: '2.0', method: 'event', params: envelope });
      link.attached.add(root);
      return { session: state.sessions.get(root), cursor: tip, ...(reset ? { reset: true } : {}) };
    },
    'session.release': ({ sessionId }, link) => { link.attached.delete(rootOf(sessionId)); return { closed: false }; },
    'session.create': ({ sessionId, spec }, link) => {
      const existing = state.sessions.get(sessionId);
      if (existing) { link.attached.add(rootOf(sessionId)); return { session: existing, attached: true }; }
      const created = summary(sessionId, spec.cwd, { ...(spec.mode ? { mode: spec.mode } : {}) });
      state.sessions.set(sessionId, created);
      link.attached.add(sessionId);
      emit(sessionId, { type: 'session.opened', session: created });
      emit(sessionId, { type: 'session.ready' });
      return { session: created, attached: false, durable: true };
    },
    'session.preview': ({ spec }) => ({ preview: { projectRoot: spec.cwd, team: 'pho', main: 'main', teams: [] } }),
    'session.prompt': ({ sessionId, clientMessageId }) => {
      if (!state.sessions.has(sessionId)) throw error(1001, 'Session is not open');
      emit(sessionId, { type: 'prompt.accepted', clientMessageId });
      emit(sessionId, { type: 'turn.started', turnId: `turn-${clientMessageId}`, origin: 'user' });
      emit(sessionId, { type: 'turn.ended', turnId: `turn-${clientMessageId}`, state: 'completed' });
      return { outcome: 'accepted', durable: true };
    },
    'session.configure': ({ sessionId, mode }) => {
      const found = state.sessions.get(sessionId);
      if (mode) found.mode = mode;
      return { session: found };
    },
    'session.rename': ({ sessionId, title }) => { const found = state.sessions.get(sessionId); found.title = title; return { session: found }; },
    'session.archive': ({ sessionId, archived = true }) => { const found = state.sessions.get(sessionId); found.archived = archived; return { session: found }; },
    'question.list': ({ projectRoot }) => ({ questions: state.questions.filter(question => projectRoot === undefined || state.sessions.get(question.rootId)?.projectRoot === projectRoot) }),
    'question.watch': ({ projectRoot, turns }, link) => {
      link.watching = { projectRoot, turns: turns === true };
      return { questions: state.questions.filter(question => projectRoot === undefined || state.sessions.get(question.rootId)?.projectRoot === projectRoot) };
    },
    'question.answer': ({ questionId }) => {
      const matches = state.questions.filter(question => question.id === questionId || question.id.startsWith(questionId));
      if (matches.length !== 1) throw error(1001, `No question ${questionId} waits for an answer`);
      state.questions = state.questions.filter(question => question !== matches[0]);
      return { questionId: matches[0].id };
    },
    'board.list': () => ({ pins: [] }),
    // Files per projectRoot (state.files), as alpd answers them; a test may plant bad paths.
    'workspace.files.search': ({ projectRoot, limit = 30 }) => ({ files: (state.files.get(projectRoot) ?? []).slice(0, limit).map(file => ({ path: file })) }),
    // workspace.files.list and read: empty by default; a test plants answers with state.handlers.
    'workspace.files.list': () => ({ entries: [] }),
    'workspace.files.read': ({ path }) => ({ path, content: '', size: 0 }),
    'session.close': () => ({}),
    // Project resources (§15): keyed by the exact projectRoot, as alpd never walks up.
    'task.list': ({ projectRoot }) => ({ projectRoot, tasks: state.tasks.get(projectRoot) ?? [], unreadable: [], revision: `r${(state.tasks.get(projectRoot) ?? []).length}` }),
    'task.create': ({ projectRoot, title }) => {
      const tasks = state.tasks.get(projectRoot) ?? [];
      const row = { id: `t-${(0xa000 + tasks.length).toString(16)}`, title, type: 'task', priority: 2, status: 'open', rev: 1 };
      state.tasks.set(projectRoot, [...tasks, row]);
      return { id: row.id };
    },
    'task.update': ({ projectRoot, id, action }) => {
      const row = (state.tasks.get(projectRoot) ?? []).find(task => task.id === id);
      if (!row) throw error(1001, `No task ${id}`, { reason: 'unknown_task' });
      Object.assign(row, { status: action === 'close' ? 'closed' : 'open', rev: row.rev + 1 });
      return { id, status: row.status, rev: row.rev };
    },
    'task.gate.resolve': ({ id }) => ({ id, status: 'open', rev: 2 }),
    'team.list': ({ projectRoot = null }) => ({ projectRoot, teams: [{ id: 'pho', source: 'builtin' }, { id: 'mine', source: 'library' }] }),
    'library.list': ({ projectRoot = null }) => ({ projectRoot, entries: [{ name: 'main', source: 'builtin' }] }),
    // An entry as alpd answers it: env redacted, a token in the URL and a secret in args not.
    // As alpd answers an MCP server (env and header values already marked), with what alpd leaves in.
    'library.get': ({ kind, name, scope }) => ({ kind, name, source: scope ?? 'project', content: { server: { url: 'https://me:SENTINEL-url@mcp.example/x?key=SENTINEL-query', args: ['--token', 'SENTINEL-arg'], env: { KEY: { $secret: 'keep' } } } }, revision: 'rev1', usedBy: [], secrets: ['/server/env/KEY'] }),
    'library.models': () => ({ models: [{ id: 'codex:gpt', label: 'GPT', efforts: [] }] }),
    'settings.language.get': () => ({ language: null, applies: 'English', default: 'English' }),
    'session.interrupt': () => ({}),
    'session.message': () => ({}),
  };

  /** One daemon connection, as an AlpTransport. */
  function open() {
    if (state.refuse) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const messages = new Set();
    const closes = new Set();
    let ended = false;
    const link = {
      id: ++nextLink,
      attached: new Set(),
      /** @type {{ projectRoot?: string } | undefined} */ watching: undefined,
      send(message) { if (!ended) { const frame = JSON.stringify(message); queueMicrotask(() => { if (!ended) for (const listener of [...messages]) listener(frame); }); } },
      end(close = {}) {
        if (ended) return;
        ended = true;
        state.links.delete(link);
        messages.clear();
        const listeners = [...closes];
        closes.clear();
        for (const listener of listeners) listener(close);
      },
    };
    state.links.add(link);
    state.opened++;
    async function handle(message) {
      if (typeof message.method !== 'string' || message.id === undefined) return;
      state.calls.push({ link: link.id, method: message.method, params: message.params ?? {} });
      const handler = state.handlers[message.method] ?? builtins[message.method];
      try {
        if (!handler) throw error(-32601, `Unknown method '${message.method}'`);
        const result = await handler(message.params ?? {}, link);
        link.send({ jsonrpc: '2.0', id: message.id, result });
      } catch (failure) {
        link.send({ jsonrpc: '2.0', id: message.id, error: typeof failure?.code === 'number' ? failure : error(1000, String(failure?.message ?? failure)) });
      }
    }
    return Promise.resolve({
      get state() { return ended ? 'closed' : 'open'; },
      send(frame) {
        if (ended) throw new Error('closed');
        const message = JSON.parse(frame);
        queueMicrotask(() => void handle(message));
      },
      onMessage(listener) { if (ended) return () => false; messages.add(listener); return () => messages.delete(listener); },
      onClose(listener) { if (ended) return () => false; closes.add(listener); return () => closes.delete(listener); },
      close() { link.end({}); },
    });
  }

  return {
    state,
    open,
    emit,
    rootOf,
    /**
     * Requests that reached the daemon for clients, optionally of one method; the gateway's
     * readiness monitor (its own connection, polling daemon.status) is left out.
     * @param {string} [method]
     */
    calls(method) {
      const monitors = new Set(state.calls.filter(call => call.method === 'daemon.hello' && call.params?.client?.name === 'alp-gateway-monitor').map(call => call.link));
      return state.calls.filter(call => !monitors.has(call.link) && (method === undefined || call.method === method));
    },
    /** Ends every daemon connection, as an alpd restart does. */
    drop() { for (const link of [...state.links]) link.end({ error: new Error('alpd went away') }); },
  };
}
