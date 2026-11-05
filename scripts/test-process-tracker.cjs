// Test-runner-only cooperative cleanup. Owners retain ChildProcess objects: no
// PID registry is ever used for signaling. Native/stripped-preload descendants
// and unresponsive owners are outside this bounded cooperative contract.
const net = require('node:net');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const endpoint = process.env.ALP_TEST_CONTROL;
if (endpoint) {
  const owner = process.env.ALP_TEST_PROCESS;
  const children = new Map();
  const pending = [];
  let connected = false;
  let cleaning = false;
  const socket = net.createConnection(endpoint);
  const send = value => {
    const line = JSON.stringify(value) + '\n';
    if (connected) socket.write(line); else pending.push(line);
  };
  socket.on('connect', () => {
    connected = true;
    socket.write(JSON.stringify({ type: 'hello', id: owner, token: process.env.ALP_TEST_SECRET }) + '\n');
    for (const line of pending) socket.write(line);
    socket.unref();
  });
  socket.on('error', () => {}); // coordinator detects absent ACK; never guess cleanup
  const original = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function(options) {
    if (cleaning) throw new Error('test runner cleanup has started');
    const id = randomUUID();
    if (options.envPairs.includes(`ALP_TEST_CONTROL=${endpoint}`)) {
      options = { ...options, envPairs: options.envPairs.filter(pair => !pair.startsWith('ALP_TEST_PROCESS=')) };
      options.envPairs.push(`ALP_TEST_PROCESS=${id}`);
    }
    children.set(id, this);
    send({ type: 'spawn', id, owner });
    const exited = () => {
      children.delete(id);
      send({ type: 'exit', id });
    };
    this.once('exit', exited);
    this.once('error', () => { if (!this.pid) exited(); });
    try { return original.call(this, options); }
    catch (error) { exited(); throw error; }
  };
  // Synchronous APIs bypass ChildProcess.prototype.spawn. Give their children
  // distinct slots too: an inherited owner ID must never let a child ACK for
  // its blocked parent. Return/throw from Node's sync call observes child exit;
  // while blocked there is no owned async handle, so cleanup must retain scratch.
  for (const method of ['spawnSync', 'execFileSync', 'execSync']) {
    const originalSync = cp[method];
    cp[method] = function(command, ...args) {
      if (cleaning) throw new Error('test runner cleanup has started');
      const id = randomUUID();
      const index = method !== 'execSync' && (Array.isArray(args[0]) || (args[0] == null && args.length > 1)) ? 1 : 0;
      const options = args[index] || {};
      const env = options.env || process.env;
      if (env.ALP_TEST_CONTROL === endpoint) {
        args[index] = {...options, env: {...env, ALP_TEST_PROCESS: id}};
      }
      send({type: 'spawn', id, owner});
      try { return originalSync.call(this, command, ...args); }
      finally { send({type: 'exit', id}); }
    };
  }
  syncBuiltinESMExports();
  let input = '';
  socket.on('data', data => {
    input += data;
    let end;
    while ((end = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      if (JSON.parse(line).type !== 'cleanup') continue;
      cleaning = true;
      // Descendant owners have already acknowledged their own children. The
      // coordinator bounds this wait; a missing exit cannot become a success.
      Promise.all([...children.values()].map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
        child.once('error', () => { if (!child.pid) resolve(); });
        child.kill('SIGKILL');
      }))).then(() => send({ type: 'ack', id: owner }));
    }
  });
}
