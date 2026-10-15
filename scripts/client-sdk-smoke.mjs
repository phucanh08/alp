#!/usr/bin/env node
// Smoke checks of the portable client SDK (docs/alp/client-sdk.md) outside node --test:
//   browser  headless Chromium runs the portable client over the browser's own WebSocket against a
//            real alpd (scripted agents) through a test-only bridge: handshake, a request, streamed
//            events, a local abort alpd ignores, and a disconnect. Playwright comes from the Paseo
//            checkout ($ALP_PASEO_SRC or .cache/paseo-web), like scripts/web-app-smoke.mjs.
//   metro    Metro (the React Native bundler) resolves and bundles the portable entries; the bundle
//            then runs in a bare JS context with no Node globals against a WebSocket double. It does
//            not run Hermes or a device: React Native's Babel preset and runtime are not installed.
//   tarball  packs protocol, core and client, installs the tarballs into an empty project and
//            checks every entry imports, the portable entries bundle for browsers from the
//            installed package, and the declarations type-check in a DOM-only and a Node project.
// Needs the builds: node scripts/build-workspace.mjs client && node scripts/build-core.mjs.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
// A throwaway ALP_HOME, set before any ALP module loads: the smoke never reads or writes ~/.alp.
const smokeHome = await mkdtemp(path.join(tmpdir(), 'alp-sdk-home-'));
process.env.ALP_HOME = smokeHome;
const load = file => import(pathToFileURL(path.join(root, file)).href);
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['browser', 'metro', 'tarball'];
const log = message => console.log(`[client-sdk] ${message}`);

/** A real alpd with scripted agents and a test-only WebSocket bridge to its socket. */
async function alpdWithBridge() {
  const { WebSocketServer, default: WebSocket } = await import('ws');
  const { createAlpRuntime } = await load('dist/runtime/index.js');
  const { createDaemonServer } = await load('dist/daemon/index.js');
  const { initProject } = await load('packages/core/src/init.js');
  const { fakeTransport } = await load('test/support/fake-agent.js');
  const { connectSocket, daemonPaths } = await load('packages/client/dist/index.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-sdk-smoke-'));
  const home = process.env.ALP_HOME;
  const project = path.join(directory, 'project');
  await initProject(project);
  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), supervisor: false, libraryDir: home });
  const socketPath = daemonPaths(directory).socket;
  const daemon = createDaemonServer({ runtime, socketPath, version: 'smoke' });
  await daemon.listen();
  daemon.extend('test.never', () => new Promise(() => {}));
  const routes = new Map();
  const server = http.createServer((request, response) => {
    const body = routes.get(new URL(request.url, 'http://x').pathname);
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': body.type, 'cache-control': 'no-store' }).end(body.text);
  });
  const sockets = new WebSocketServer({ server, path: '/rpc' });
  sockets.on('connection', ws => {
    const early = [];
    let transport;
    ws.on('message', data => { const frame = data.toString('utf8'); if (transport) transport.send(frame); else early.push(frame); });
    connectSocket(socketPath).then(opened => {
      transport = opened;
      if (ws.readyState !== WebSocket.OPEN) return transport.close();
      for (const frame of early.splice(0)) transport.send(frame);
      transport.onMessage(frame => ws.send(frame));
      transport.onClose(() => ws.close(1011, 'alpd connection ended'));
      ws.on('close', () => transport.close());
    }, () => ws.close(1011, 'alpd unreachable'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    project, agents, routes, origin, url: `${origin.replace('http', 'ws')}/rpc`,
    kick(code, reason) { for (const ws of sockets.clients) ws.close(code, reason); },
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise(resolve => server.close(resolve));
      await daemon.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The page's script: the portable SDK as a browser app would bundle it. */
const PAGE_ENTRY = `
import { AlpRpcClient, hello, isAlpClientError } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
const events = [];
let client;
window.sdk = {
  async open(url) {
    client = new AlpRpcClient(await connectWebSocket(url));
    client.onEvent(envelope => events.push(envelope));
    return (await hello(client, { name: 'browser-smoke', version: navigator.userAgent.slice(0, 40) })).protocolVersion;
  },
  request: (method, params) => client.request(method, params),
  types: sessionId => events.filter(e => e.sessionId === sessionId).map(e => e.event.type),
  accepted: id => events.some(e => e.event.type === 'prompt.accepted' && e.event.clientMessageId === id),
  async abortedPrompt(params) {
    const controller = new AbortController();
    const waiting = client.request('session.prompt', params, { signal: controller.signal });
    controller.abort();
    try { await waiting; return 'resolved'; } catch (error) { return isAlpClientError(error) ? error.reason : String(error); }
  },
  startNever() { window.never = client.request('test.never').then(() => 'resolved', error => ({ reason: error.reason, code: error.data?.code, closeReason: error.data?.reason })); return true; },
  never: () => window.never,
  closed: () => client.closed,
  hasNode: () => ({ process: typeof process, Buffer: typeof Buffer }),
};
`;

async function browser() {
  const { build } = await import('esbuild');
  const source = path.resolve(process.env.ALP_PASEO_SRC ?? path.join(root, '.cache/paseo-web'));
  const { chromium } = await import(pathToFileURL(path.join(source, 'node_modules/playwright/index.mjs')).href);
  const bundle = await build({ absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', stdin: { contents: PAGE_ENTRY, resolveDir: root, loader: 'js' }, logLevel: 'silent' });
  const alpd = await alpdWithBridge();
  alpd.routes.set('/', { type: 'text/html; charset=utf-8', text: '<!doctype html><meta charset="utf-8"><title>ALP SDK smoke</title><script type="module" src="/app.js"></script>' });
  alpd.routes.set('/app.js', { type: 'text/javascript; charset=utf-8', text: bundle.outputFiles[0].text });
  const instance = await chromium.launch({ headless: true, channel: process.env.ALP_SMOKE_BROWSER ?? 'chrome' });
  const errors = [];
  try {
    const page = await instance.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(alpd.origin);
    await page.waitForFunction(() => window.sdk);
    log(`browser ${instance.version()}: Node globals in page ${JSON.stringify(await page.evaluate(() => window.sdk.hasNode()))}`);
    const version = await page.evaluate(url => window.sdk.open(url), alpd.url);
    if (version !== 1) throw new Error(`handshake answered protocol ${version}`);
    const status = await page.evaluate(() => window.sdk.request('daemon.status'));
    if (status.health?.live !== true) throw new Error('daemon.status did not report a live alpd');
    const { session } = await page.evaluate(cwd => window.sdk.request('session.create', { spec: { cwd } }), alpd.project);
    await page.evaluate(id => window.sdk.request('session.prompt', { sessionId: id, clientMessageId: 'm1', content: [{ type: 'text', text: 'Hello' }] }), session.id);
    alpd.agents[0].finish('Hi from the agent');
    await page.waitForFunction(id => window.sdk.types(id).includes('turn.ended'), session.id, { timeout: 10_000 });
    log(`streamed events: ${(await page.evaluate(id => window.sdk.types(id), session.id)).join(', ')}`);
    const aborted = await page.evaluate(id => window.sdk.abortedPrompt({ sessionId: id, clientMessageId: 'm2', content: [{ type: 'text', text: 'Again' }] }), session.id);
    if (aborted !== 'aborted') throw new Error(`aborted prompt ended as ${aborted}`);
    await page.waitForFunction(() => window.sdk.accepted('m2'), null, { timeout: 10_000 });
    log('a local abort ended the wait only; alpd still accepted the prompt');
    await page.evaluate(() => window.sdk.startNever());
    await new Promise(resolve => setTimeout(resolve, 100));
    alpd.kick(4000, 'smoke disconnect');
    const outcome = await page.evaluate(() => window.sdk.never());
    if (outcome?.reason !== 'disconnected' || outcome.code !== 4000 || !(await page.evaluate(() => window.sdk.closed()))) throw new Error(`disconnect ended as ${JSON.stringify(outcome)}`);
    log(`disconnect rejected the waiting request: ${JSON.stringify(outcome)}`);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    log('browser smoke passed');
  } finally {
    await instance.close();
    await alpd.close();
  }
}

/** A WebSocket double for the Metro bundle: answers hello and daemon.status, then closes. */
function webSocketDouble(record) {
  return class {
    constructor(url) {
      record.push(`open ${url}`);
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.listeners = {};
      setTimeout(() => { this.readyState = 1; this.emit('open', {}); }, 0);
    }
    addEventListener(type, listener) { (this.listeners[type] ??= new Set()).add(listener); }
    removeEventListener(type, listener) { this.listeners[type]?.delete(listener); }
    emit(type, event) { for (const listener of [...(this.listeners[type] ?? [])]) listener(event); }
    send(data) {
      const message = JSON.parse(data);
      record.push(`send ${message.method}`);
      const result = message.method === 'daemon.hello' ? { protocolVersion: 1 } : { health: { live: true } };
      setTimeout(() => this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) }), 0);
    }
    close(code = 1000, reason = '') { this.readyState = 3; setTimeout(() => this.emit('close', { code, reason }), 0); }
  };
}

async function metro() {
  const Metro = await import('metro');
  const { getDefaultConfig, mergeConfig } = await import('metro-config');
  const work = path.join(root, '.cache', 'client-sdk-metro');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const entry = path.join(work, 'index.js');
  await writeFile(entry, `
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
globalThis.smoke = (async () => {
  const client = new AlpRpcClient(await connectWebSocket('wss://alp.invalid/rpc'));
  const version = (await hello(client, { name: 'metro-smoke', version: '0' })).protocolVersion;
  const status = await client.request('daemon.status');
  client.close();
  return { version, live: status.health.live, closed: client.closed };
})();
`);
  const defaults = await getDefaultConfig(root);
  const config = mergeConfig(defaults, {
    projectRoot: root,
    watchFolders: [root],
    cacheStores: [],
    resolver: {
      unstable_enablePackageExports: true,
      unstable_conditionNames: ['react-native', 'import', 'require', 'default'],
      nodeModulesPaths: [path.join(root, 'node_modules')],
      blockList: [/\/\.cache\/paseo-web\/.*/, /\/dist\/web-app\/.*/],
    },
    // No React Native Babel preset here: Metro's own import/export transform turns ES modules into
    // its module system, and syntax passes through as the SDK wrote it.
    transformer: {
      babelTransformerPath: (await import('node:module')).createRequire(import.meta.url).resolve('metro-babel-transformer'),
      getTransformOptions: async () => ({ transform: { experimentalImportSupport: true, inlineRequires: false } }),
    },
  });
  const outputs = [];
  for (const platform of ['ios', 'android']) {
    const out = path.join(work, `bundle.${platform}.js`);
    await Metro.runBuild(config, { entry, platform, dev: false, minify: false, out, sourceMap: false });
    outputs.push(out);
  }
  const { readFile } = await import('node:fs/promises');
  for (const out of outputs) {
    const code = await readFile(out, 'utf8');
    for (const forbidden of [/require\(["']node:/, /["']node:(net|fs|os|path|child_process|crypto)["']/, /@anhlp\/alp-core/]) {
      if (forbidden.test(code)) throw new Error(`${path.basename(out)} contains ${forbidden}`);
    }
    // A bare context: no process, Buffer, require or module; only timers and the WebSocket double.
    const record = [];
    const context = vm.createContext({ setTimeout, clearTimeout, queueMicrotask, console, WebSocket: webSocketDouble(record) });
    vm.runInContext(code, context, { filename: out });
    const result = await context.smoke;
    if (result.version !== 1 || result.live !== true || result.closed !== true) throw new Error(`${path.basename(out)} ran to ${JSON.stringify(result)}`);
    log(`metro ${path.basename(out)}: ${(code.length / 1024).toFixed(0)} KiB, ran without Node globals: ${record.join(' → ')}`);
  }
  await rm(work, { recursive: true, force: true });
  log('metro smoke passed (bundle resolution and a bare JS runtime; no Hermes or device run)');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function tarball() {
  const { build } = await import('esbuild');
  const work = await mkdtemp(path.join(tmpdir(), 'alp-sdk-tarball-'));
  try {
    const packs = path.join(work, 'packs');
    await mkdir(packs);
    for (const name of ['protocol', 'core', 'client']) run('npm', ['pack', '--ignore-scripts', '--pack-destination', packs, '--workspace', `@anhlp/alp-${name}`], { cwd: root });
    const files = (await readdir(packs)).map(file => path.join(packs, file));
    const consumer = path.join(work, 'consumer');
    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'sdk-consumer', private: true, type: 'module' }));
    run('npm', ['install', '--no-audit', '--no-fund', '--offline', '--ignore-scripts', ...files], { cwd: consumer });
    // Every public entry imports from the installed package.
    const imports = run(process.execPath, ['--input-type=module', '-e', `
      const portable = await import('@anhlp/alp-client/portable');
      const websocket = await import('@anhlp/alp-client/websocket');
      const ipc = await import('@anhlp/alp-client/ipc');
      const node = await import('@anhlp/alp-client');
      const need = { portable: ['AlpRpcClient', 'AlpClientError', 'CLIENT_ERROR', 'isAlpClientError', 'createReconnectingClient', 'hello', 'createLineDecoder', 'PROTOCOL_VERSION', 'MAX_FRAME', 'AlpRpcError'], websocket: ['connectWebSocket', 'createWebSocketTransport', 'redactUrl'], ipc: ['createSocketTransport'], node: ['AlpClient', 'connect', 'connectSocket', 'ensureDaemon', 'daemonPaths', 'assertPrivateSocket', 'alpHome', 'AlpRpcClient', 'createSocketTransport'] };
      const modules = { portable, websocket, ipc, node };
      for (const [name, names] of Object.entries(need)) for (const key of names) if (!(key in modules[name])) throw new Error(name + ' lacks ' + key);
      if (!(new node.AlpClient(new (await import('node:net')).Socket()) instanceof portable.AlpRpcClient)) throw new Error('AlpClient is not the portable engine');
      console.log('imports ok');
    `], { cwd: consumer });
    log(`tarball: ${imports.trim()} (${files.map(file => path.basename(file)).join(', ')})`);
    // The installed portable entries bundle for a browser with nothing from Node or ALP core.
    const result = await build({ absWorkingDir: consumer, bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm', stdin: { contents: "export * from '@anhlp/alp-client/portable';\nexport * from '@anhlp/alp-client/websocket';", resolveDir: consumer }, logLevel: 'silent' });
    const inputs = Object.keys(result.metafile.inputs).filter(input => input !== '<stdin>');
    const stray = inputs.filter(input => !/^node_modules\/@anhlp\/alp-(client\/src\/(portable|websocket|rpc\/[a-z]+)|protocol\/src\/(public|wire))\.js$/.test(input));
    if (stray.length) throw new Error(`installed portable bundle pulls in ${stray.join(', ')}`);
    log(`tarball: browser bundle of the installed package has ${inputs.length} modules, all portable`);
    // Declarations: a DOM-only project (no @types/node) and a Node project both type-check.
    await writeFile(path.join(consumer, 'browser.ts'), `
import { AlpRpcClient, AlpClientError, createReconnectingClient, hello, isAlpClientError, type AlpTransport, type ReconnectingClient } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
export async function main(url: string): Promise<number> {
  const transport: AlpTransport = await connectWebSocket(url, { WebSocket, protocols: ['alp.v1'], signal: new AbortController().signal });
  const client = new AlpRpcClient(transport, { timeoutMs: 1000 });
  client.onEvent(envelope => console.log(envelope));
  const reconnecting: ReconnectingClient = createReconnectingClient({ connect: ({ signal }) => connectWebSocket(url, { signal }), onConnect: rpc => hello(rpc) });
  reconnecting.stop();
  try { return (await hello(client)).protocolVersion; } catch (error) { if (isAlpClientError(error, 'timeout')) return -1; throw error instanceof AlpClientError ? error : error; }
}
`);
    await writeFile(path.join(consumer, 'node.ts'), `
import { AlpClient, connect, connectSocket, AlpRpcClient, type AlpTransport } from '@anhlp/alp-client';
import { createSocketTransport } from '@anhlp/alp-client/ipc';
import net from 'node:net';
export async function main(socketPath: string) {
  const legacy: AlpClient = await connect(socketPath, { name: 'x', version: '0' });
  const portable = new AlpRpcClient(await connectSocket(socketPath));
  const transport: AlpTransport = createSocketTransport(net.createConnection(socketPath));
  return [legacy.closed, portable.pendingCount, transport.state];
}
`);
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
    for (const resolution of ['bundler', 'node16']) {
      const compilerOptions = { noEmit: true, strict: true, skipLibCheck: false, target: 'ES2022', module: resolution === 'node16' ? 'node16' : 'ESNext', moduleResolution: resolution };
      await writeFile(path.join(consumer, 'tsconfig.browser.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, lib: ['ES2022', 'DOM'], types: [] }, files: ['browser.ts'] }));
      await writeFile(path.join(consumer, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, lib: ['ES2022'], typeRoots: [path.join(root, 'node_modules/@types')], types: ['node'] }, files: ['node.ts'] }));
      run(process.execPath, [tsc, '-p', 'tsconfig.browser.json'], { cwd: consumer });
      run(process.execPath, [tsc, '-p', 'tsconfig.node.json'], { cwd: consumer });
    }
    log('tarball: declarations type-check for a DOM-only project and a Node project (bundler and node16 resolution)');
    log('tarball smoke passed');
  } finally { await rm(work, { recursive: true, force: true }); }
}

const runs = { browser, metro, tarball };
try {
  for (const mode of modes) {
    if (!runs[mode]) throw new Error(`Usage: client-sdk-smoke.mjs [${Object.keys(runs).join('|')}]...`);
    await runs[mode]();
  }
} finally { await rm(smokeHome, { recursive: true, force: true }); }
