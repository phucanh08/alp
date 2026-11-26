import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFileTransferFrame as encode, FileTransferOpcode as O } from '@getpaseo/protocol/binary-frames/index';
import { createFacadeUploads, FACADE_UPLOAD_LIMITS } from '../server/dist/paseo/uploads.js';
import { createPaseoGateway } from '../server/dist/paseo/gateway.js';
import { EventEmitter } from 'node:events';
const request = (requestId = 'u', extra = {}) => ({ type: 'file.upload.request', requestId, fileName: 'report.bin', mimeType: 'application/octet-stream', size: 3, modifiedAt: '2026-10-24T00:00:00Z', ...extra });
const begin = r => encode({ opcode: O.FileBegin, requestId: r.requestId, metadata: { fileName: r.fileName, mime: r.mimeType, size: r.size, encoding: 'binary', modifiedAt: r.modifiedAt } });
const chunk = (r, bytes = [0, 255, 1]) => encode({ opcode: O.FileChunk, requestId: r.requestId, payload: new Uint8Array(bytes) });
const end = r => encode({ opcode: O.FileEnd, requestId: r.requestId });
const client = () => ({ clientId: 'same-untrusted-id', sent: [], emit(m) { this.sent.push(m); } });
function setup(t, limits = {}) { const store = createFacadeUploads({ ...FACADE_UPLOAD_LIMITS, ...limits }); t.after(() => store.close()); const c = client(); store.add(c); return { store, c }; }
function upload(store, c, r = request()) { assert.equal(store.request(r, c), undefined); store.binary(begin(r), c); store.binary(chunk(r), c); store.binary(end(r), c); return c.sent.at(-1).payload.file; }

test('exact upstream codec stages opaque bytes, connection identity grants and metadata checks', t => {
  const { store, c } = setup(t);
  const file = upload(store, c);
  assert.equal(file.path, `alp-upload:${file.id}`);
  const lease = store.lease(c, [file]);
  assert.deepEqual([...lease.files[0].data], [0, 255, 1]); lease.release();
  const other = client(); store.add(other);
  assert.throws(() => store.lease(other, [file]), /not uploaded on this connection/);
  for (const changed of [{ path: '/etc/passwd' }, { size: 4 }, { mimeType: 'text/plain' }, { id: 'unknown' }, { fileName: '../secret' }]) assert.throws(() => store.lease(c, [{ ...file, ...changed }]), /not uploaded/);
  store.drop(c); assert.throws(() => store.lease(c, [file]), /closed/);
});

test('request registration is synchronous and errors release reserved quotas', t => {
  const { store, c } = setup(t, { maxObjectBytes: 3, maxConnectionBytes: 3, maxTotalBytes: 3, maxConnectionFiles: 1, maxTotalFiles: 1 });
  for (const change of [{ size: -1 }, { size: 4 }, { size: 1.2 }, { fileName: '../x' }, { fileName: 'C:\\secret' }, { fileName: 'a\u0000' }, { mimeType: 'x\r\nx/y' }, { modifiedAt: '?' }, { requestId: 'x'.repeat(256) }]) assert.match(store.request(request('bad', change), c).payload.error, /Invalid|limit/);
  const r = request(); store.request(r, c);
  assert.match(store.request(request('u2'), c).payload.error, /quota/);
  store.binary(chunk(r), c); assert.match(c.sent.at(-1).payload.error, /before Begin/);
  assert.ok(upload(store, c, request('retry')));
  assert.match(store.request(request('done-quota'), c).payload.error, /quota/, 'completed files stay accounted');
});

test('malformed frame, mismatched/duplicate Begin, oversized/short/extra data and End fail natively', t => {
  const { store, c } = setup(t, { maxFrameBytes: 300 });
  for (const apply of [
    r => store.binary(new Uint8Array([0x10]), c),
    r => store.binary(new Uint8Array(301), c),
    r => store.binary(begin({ ...r, fileName: 'other' }), c),
    r => { store.binary(begin(r), c); store.binary(begin(r), c); },
    r => { store.binary(begin(r), c); store.binary(chunk(r, [1,2,3,4]), c); },
    r => { store.binary(begin(r), c); store.binary(end(r), c); },
    r => { store.binary(begin(r), c); store.binary(new Uint8Array([...end(r), 0]), c); },
  ]) {
    const r = request(); store.request(r, c); const before = c.sent.length; apply(r);
    assert.equal(c.sent.length, before + 1); assert.equal(c.sent.at(-1).type, 'file.upload.response'); assert.equal(c.sent.at(-1).payload.file, null); assert.ok(c.sent.at(-1).payload.error);
  }
  const r = request(); store.request(r, c); assert.match(store.request(r, c).payload.error, /Duplicate/);
  assert.ok(upload(store, c, request('new')));
});

test('server-wide quota includes other sockets, completed files and outstanding leases after drop', t => {
  const { store, c } = setup(t, { maxTotalBytes: 3 });
  const other = client(); store.add(other);
  const file = upload(store, c); const lease = store.lease(c, [file]);
  assert.match(store.request(request(), other).payload.error, /quota/);
  store.drop(c); assert.throws(lease.assertActive, /closed/);
  assert.deepEqual([...lease.files[0].data], [0,255,1]);
  assert.match(store.request(request(), other).payload.error, /quota/);
  lease.release(); lease.release(); assert.ok(upload(store, other));
});

test('expiry removes future grants, keeps leased bytes accounted, and errors incomplete requests', async t => {
  const { store, c } = setup(t, { timeoutMs: 15, maxTotalBytes: 3 });
  const file = upload(store, c); const lease = store.lease(c, [file]);
  await new Promise(r => setTimeout(r, 30));
  assert.throws(() => store.lease(c, [file]), /expired/);
  assert.match(store.request(request('new'), c).payload.error, /quota/);
  assert.deepEqual([...lease.files[0].data], [0,255,1]); lease.release();
  store.request(request('pending'), c); await new Promise(r => setTimeout(r, 30));
  assert.match(c.sent.at(-1).payload.error, /timed out/);
  assert.ok(upload(store, c, request('again')));
});

test('gateway authenticates synchronously before immediate upload frames; close defeats late async hello', async t => {
  const { store } = setup(t);
  let finish; const gate = new Promise(r => finish = r);
  const gateway = createPaseoGateway({ token: () => 'secret', serverId: () => 's', version: 'test', features: {}, beforeServerInfo: () => gate,
    handlers: { 'file.upload.request': (r,c) => store.request(r,c) }, onBinary: (b,c) => store.binary(b,c), onClient: c => { store.add(c); return () => store.drop(c); } });
  class Socket extends EventEmitter { readyState=1; sent=[]; send(m) { this.sent.push(JSON.parse(m)); } close() { this.readyState=3; this.emit('close'); } }
  const ws = new Socket(); gateway.attach(ws);
  ws.emit('message', JSON.stringify({ type: 'hello', clientId: 'same', protocolVersion: 1, auth: { kind: 'password', password: 'secret' } }));
  const r = request(); ws.emit('message', JSON.stringify({ type: 'session', message: r }));
  for (const b of [begin(r), chunk(r), end(r)]) ws.emit('message', b, true);
  assert.ok(ws.sent.find(f => f.message?.type === 'file.upload.response')?.message.payload.file);
  ws.close(); finish(); await gate; await new Promise(r => setImmediate(r));
  assert.equal(gateway.clients,0); assert.ok(!ws.sent.some(f => f.message?.payload?.status === 'server_info'));
  ws.emit('message', JSON.stringify({ type: 'hello', clientId: 'same', protocolVersion: 1, auth: { kind: 'password', password: 'secret' } }));
  assert.equal(gateway.clients,0);
});

test('global count reservation applies even to zero-byte completed files', t => {
  const {store,c}=setup(t,{maxTotalFiles:1});const other=client();store.add(other);
  const r=request('zero',{size:0});store.request(r,c);store.binary(begin(r),c);store.binary(end(r),c);
  assert.ok(c.sent.at(-1).payload.file);assert.match(store.request(request('zero2',{size:0}),other).payload.error,/quota/);
  store.drop(c);assert.equal(store.request(request('zero2',{size:0}),other),undefined);
});

test('gateway relay-style typed bytes are binary while ws text buffers remain JSON', async t=> {
  const {store}=setup(t);let c;
  const gateway=createPaseoGateway({token:()=> 'secret',serverId:()=> 's',version:'test',features:{},handlers:{'file.upload.request':(m,c)=>store.request(m,c)},onBinary:(b,c)=>store.binary(b,c),onClient:client=>{c=client;store.add(c);return()=>store.drop(c);}});
  class Socket extends EventEmitter {readyState=1;sent=[];send(m){this.sent.push(JSON.parse(m));}close(){this.emit('close');}}
  const ws=new Socket();gateway.attach(ws);t.after(()=>ws.close());
  ws.emit('message',Buffer.from(JSON.stringify({type:'hello',clientId:'same',protocolVersion:1,auth:{kind:'password',password:'secret'}})),false);
  const r=request();ws.emit('message',Buffer.from(JSON.stringify({type:'session',message:r})),false);
  for(const b of [begin(r),chunk(r),end(r)])ws.emit('message',b);
  const file=ws.sent.find(f=>f.message?.type==='file.upload.response').message.payload.file;
  const lease=store.lease(c,[file]);assert.deepEqual([...lease.files[0].data],[0,255,1]);lease.release();
});
