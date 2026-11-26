// A client of alpd that shares nothing with it but the socket, as a remote Paseo would through the
// gateway: its own HOME, ALP_HOME and working directory, only the portable SDK and the IPC
// transport, and (under Node's permission model) no read access to the daemon's home or projects.
// argv: the socket path, then a JSON list of [method, params]. Prints one JSON report on stdout.
import net from 'node:net';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { createSocketTransport } from '@anhlp/alp-client/ipc';

const [socketPath, steps] = [process.argv[2], JSON.parse(process.argv[3])];
const socket = net.createConnection(socketPath);
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
const client = new AlpRpcClient(createSocketTransport(socket), { timeoutMs: 15_000 });
const report = { hello: await hello(client, { name: 'remote-fixture', version: '0' }), calls: [] };
for (const [method, params] of steps) {
  try { report.calls.push({ method, result: await client.request(method, params) }); }
  catch (error) { report.calls.push({ method, error: { code: error.code, reason: error.data?.reason, message: error.message } }); }
}
client.close();
process.stdout.write(JSON.stringify(report));
