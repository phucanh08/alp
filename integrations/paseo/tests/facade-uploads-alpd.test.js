// Provider-independent: real facade WebSocket -> real daemon store -> real runtime, scripted native
// transport. ALP_HOME must also be isolated by the invoking test command, before modules load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, lstat, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeFileTransferFrame as encode, FileTransferOpcode as O } from '@getpaseo/protocol/binary-frames/index';
import { FileUploadResponseSchema, SendAgentMessageResponseMessageSchema, AgentStreamMessageSchema } from '@getpaseo/protocol/messages';
import { initProject } from '@anhlp/alp-core/init';
import { daemonPaths } from '@anhlp/alp-client';
import { ATTACHMENT_HEADER, attachmentStageDir, createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { createPaseoBridge } from '../server/dist/paseo/index.js';

const hash = data => createHash('sha256').update(data).digest('hex');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i=0;i<600;i++) { const value = await fn(); if (value) return value; await pause(5); } assert.fail('condition timed out'); }
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise, resolve}; };

async function fixture(t, limits) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-facade-files-')));
  const home = path.join(dir, 'home'), project = path.join(dir, 'project');
  await mkdir(home); await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  if (limits) await writeFile(path.join(home,'attachments.json'), JSON.stringify({limits}));
  const native = [];
  const runtime = createAlpRuntime({ supervisor:false, runLogDir:path.join(dir,'runs'), attachmentStageDir:attachmentStageDir(home), transport:() => {
    const tr = { async initialize() {}, onNotification(fn) { this.notify=fn; }, onFailure() {}, onRequest() {}, async close() {},
      async request(method, params) {
        if (method.startsWith('thread/')) return {thread:{id:'thread-'+native.length}};
        if (method === 'turn/start') { native.push(params); const id='turn-'+native.length; setTimeout(()=>this.notify?.('turn/completed',{threadId:params.threadId,turn:{id,status:'completed'}}),5); return {turn:{id}}; }
        return {};
      } };
    return tr;
  } });
  const store=createStore(path.join(home,'state'));
  const server=createDaemonServer({runtime, socketPath:daemonPaths(path.join(dir,'d')).socket, version:'test',store,home,attachmentOptions:{limits}});
  const rpc=server.local();
  await rpc.request('session.create',{sessionId:'root',spec:{cwd:project,persist:true}});
  const calls=[]; let gate; let failure;
  const bridge=createPaseoBridge({home,version:'test',token:()=> 'secret', serverId:()=> 'server',
    clientFactory:async onEvent => { const conn=server.local(); conn.onEvent(onEvent); return {...conn, async request(method,params) { calls.push({method,params}); if(failure===method) { failure=undefined; throw new Error('controlled attachment failure'); } if(gate?.method===method) { const g=gate; gate=undefined; g.entered.resolve(); await g.release.promise; } return conn.request(method,params); }}; },
  });
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'}); await once(wss,'listening');
  wss.on('connection',ws=>bridge.attach(ws));
  const clients=[];
  t.after(async()=> { for(const c of clients) c.ws.terminate(); for(const ws of wss.clients) ws.terminate(); await new Promise(r=>wss.close(r)); await bridge.close(); rpc.close(); await store.flush(); await server.close(); await runtime.shutdown(); await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}); });
  async function connect() {
    const ws=new WebSocket(`ws://127.0.0.1:${wss.address().port}`), frames=[];
    ws.on('message',(data,binary)=>{if(!binary) frames.push(JSON.parse(String(data)));}); await once(ws,'open');
    const send=m=>ws.send(JSON.stringify({type:'session',message:m}));
    const take=async(type,id)=> (await until(()=>frames.find(f=>f.message?.type===type && (id===undefined || f.message.payload?.requestId===id)))).message;
    ws.send(JSON.stringify({type:'hello',clientId:'SAME-UNTRUSTED-ID',protocolVersion:1,auth:{kind:'password',password:'secret'}}));
    await take('status');
    const c={ws,frames,send,take};clients.push(c);return c;
  }
  async function upload(c,id='u',data=Buffer.from([0,255,2]),name='report.bin') {
    const r={type:'file.upload.request',requestId:id,fileName:name,mimeType:'application/octet-stream',size:data.length,modifiedAt:'2026-10-24T00:00:00Z'};
    c.send(r);
    c.ws.send(encode({opcode:O.FileBegin,requestId:id,metadata:{mime:r.mimeType,size:r.size,encoding:'binary',modifiedAt:r.modifiedAt,fileName:name}}));
    // True binary frames; begin is sent immediately after JSON request, without an intermediate ack.
    if(data.length)c.ws.send(encode({opcode:O.FileChunk,requestId:id,payload:data}));
    c.ws.send(encode({opcode:O.FileEnd,requestId:id}));
    const response=await c.take('file.upload.response',id);assert.ok(FileUploadResponseSchema.safeParse(response).success);assert.equal(response.payload.error,null);return response.payload.file;
  }
  return {url:`ws://127.0.0.1:${wss.address().port}`,home,project,native,rpc,calls,connect,upload, failNext(method) { failure=method; }, block(method) { const g={method,entered:deferred(),release:deferred()};gate=g;return g; }};
}
const skip=process.platform==='win32' && 'daemon attachments require POSIX';

test('facade binary upload reaches runtime byte-for-byte, no provider; retry and closed-session reopen', {skip}, async t=> {
  const f=await fixture(t), c=await f.connect();
  const data=Buffer.from([0,1,255,0,9]);const file=await f.upload(c,'u',data);
  await f.rpc.request('session.close',{sessionId:'root'});
  c.send({type:'send_agent_message_request',requestId:'p',agentId:'root',text:'read',messageId:'same-message',attachments:[file]});
  const reply=await c.take('send_agent_message_response','p');assert.ok(SendAgentMessageResponseMessageSchema.safeParse(reply).success);assert.equal(reply.payload.error,null);
  await until(()=>f.native.length===1);
  const named=f.native[0].input.filter(p=>p.type==='text'&&p.text.startsWith(ATTACHMENT_HEADER)).map(p=>JSON.parse(p.text.slice(ATTACHMENT_HEADER.length).split('\n')[0]));
  assert.equal(named.length,1);assert.equal(named[0].sha256,hash(data));assert.equal(path.dirname(named[0].path),attachmentStageDir(f.home));assert.deepEqual(await readFile(named[0].path),data);assert.equal((await lstat(named[0].path)).mode&0o777,0o400);
  assert.ok(!JSON.stringify(f.native).includes('alp-upload:'));
  c.send({type:'send_agent_message_request',requestId:'p2',agentId:'root',text:'read',messageId:'same-message',attachments:[file]});
  assert.equal((await c.take('send_agent_message_response','p2')).payload.error,null);await pause(30);assert.equal(f.native.length,1);
  assert.equal(f.calls.filter(x=>x.method==='attachment.begin').length,2,'retry asks daemon to reuse same object');
});

test('facade same hello id on another socket cannot send or create using a file; malformed attachments refuse whole', {skip}, async t=> {
  const f=await fixture(t), c=await f.connect(), other=await f.connect();const file=await f.upload(c);
  for(const [id,attachments] of [['foreign',[file]],['path',[{...file,path:'/etc/passwd'}]],['mixed',[file,{type:'text',text:'secret',title:'ctx',mimeType:'text/plain'}]],['shape',{}]]) {
    const socket=id==='foreign'?other:c;
    socket.send({type:'send_agent_message_request',requestId:id,agentId:'root',text:'do not drop',activeTurnBehavior:'interrupt',attachments});
    assert.equal((await socket.take('send_agent_message_response',id)).payload.accepted,false);
  }
  other.send({type:'create_agent_request',requestId:'create-bad',config:{provider:'alp',cwd:f.project},attachments:[file]});
  assert.equal((await other.take('status','create-bad')).payload.status,'agent_create_failed');
  assert.equal(f.calls.filter(x=>['attachment.begin','session.prompt','session.interrupt','session.create'].includes(x.method)).length,0);
});

test('attachment-only new-agent first prompt and legacy one-way inline images/files reach runtime', {skip}, async t=> {
  const f=await fixture(t),c=await f.connect();const file=await f.upload(c);
  c.send({type:'create_agent_request',requestId:'new',config:{provider:'alp',cwd:f.project},clientMessageId:'first',attachments:[file]});
  const reply=await c.take('status','new');assert.equal(reply.payload.status,'agent_created',JSON.stringify(reply));await until(()=>f.native.length===1);
  c.send({type:'send_agent_message',agentId:reply.payload.agentId,text:'legacy',messageId:'legacy',images:[{mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}],attachments:[file]});
  await until(()=>f.native.length===2);
  assert.ok(f.native[1].input.some(p=>p.type==='image'));
  assert.ok(f.native[1].input.some(p=>p.type==='text'&&p.text.startsWith(ATTACHMENT_HEADER)));
  c.send({type:'send_agent_message',agentId:'root',text:'bad',attachments:[{...file,path:'/etc/passwd'}]});
  const failure=await until(()=>c.frames.find(x=>x.message?.type==='agent_stream'&&x.message.payload.event.type==='turn_failed'));
  assert.ok(AgentStreamMessageSchema.safeParse(failure.message).success);assert.equal(f.native.length,2);
});

test('daemon lowered limits refuse the whole message before upload or interruption', {skip}, async t=> {
  const f=await fixture(t,{maxObjectBytes:2}),c=await f.connect();const file=await f.upload(c);
  c.send({type:'send_agent_message_request',requestId:'limits',agentId:'root',text:'no partial',attachments:[file],activeTurnBehavior:'interrupt'});
  assert.match((await c.take('send_agent_message_response','limits')).payload.error,/limits/);
  assert.ok(!f.calls.some(x=>['attachment.begin','session.interrupt','session.prompt'].includes(x.method)));assert.equal(f.native.length,0);
});

test('disconnect during daemon hello prevents late upload or prompt; connection cannot resurrect grants', {skip}, async t=> {
  const f=await fixture(t),c=await f.connect();const file=await f.upload(c);const g=f.block('daemon.hello');
  c.send({type:'send_agent_message_request',requestId:'close',agentId:'root',text:'do not deliver',attachments:[file]});await g.entered.promise;
  c.ws.close();await once(c.ws,'close');await pause(10);g.release.resolve();await pause(30);
  assert.ok(!f.calls.some(x=>['attachment.begin','session.prompt'].includes(x.method)));assert.equal(f.native.length,0);
  const other=await f.connect();other.send({type:'send_agent_message_request',requestId:'stale',agentId:'root',text:'no',attachments:[file]});assert.equal((await other.take('send_agent_message_response','stale')).payload.accepted,false);
});


test('Paseo SDK uploadFile uses its own codec against facade hello and prompt delivery', {skip}, async t => {
  const { DaemonClient } = await import(process.env.ALP_TEST_PASEO_CLIENT_MODULE ?? '@getpaseo/client/internal/daemon-client');
  const f=await fixture(t);
  const client = new DaemonClient({ url:f.url, clientId:'sdk', password:'secret', webSocketFactory:(url, options) => new WebSocket(url, options?.protocols), reconnect:{enabled:false} });
  t.after(()=>client.close());
  await client.connect();
  const bytes=Buffer.from([0,255,2,0,3,10]);
  const result=await client.uploadFile({fileName:'sdk.bin',mimeType:'application/octet-stream',bytes,chunkSize:1});
  assert.equal(result.error,null);assert.ok(result.file?.path.startsWith('alp-upload:'));
  await client.sendAgentMessage('root','SDK binary',{attachments:[result.file],messageId:'sdk-message'});
  await until(()=>f.native.length===1);
  const part=f.native[0].input.find(p=>p.type==='text'&&p.text.startsWith(ATTACHMENT_HEADER));
  const named=JSON.parse(part.text.slice(ATTACHMENT_HEADER.length).split('\n')[0]);
  assert.deepEqual(await readFile(named.path),bytes);
});


test('failed daemon chunk aborts the upload and sends no partial prompt; retry can deliver', {skip}, async t => {
  const f=await fixture(t),c=await f.connect(),file=await f.upload(c);
  f.failNext('attachment.chunk');
  c.send({type:'send_agent_message_request',requestId:'failed',agentId:'root',text:'all or nothing',messageId:'failed-message',attachments:[file]});
  assert.match((await c.take('send_agent_message_response','failed')).payload.error,/controlled attachment failure/);
  assert.ok(f.calls.some(x=>x.method==='attachment.abort'));assert.ok(!f.calls.some(x=>x.method==='session.prompt'));
  c.send({type:'send_agent_message_request',requestId:'retry',agentId:'root',text:'all or nothing',messageId:'retry-message',attachments:[file]});
  assert.equal((await c.take('send_agent_message_response','retry')).payload.error,null);await until(()=>f.native.length===1);
});

test('disconnect during a chunk aborts the in-flight daemon reservation before late prompt', {skip}, async t => {
  const f=await fixture(t),c=await f.connect(),file=await f.upload(c);const g=f.block('attachment.chunk');
  t.after(()=>g.release.resolve());
  c.send({type:'send_agent_message_request',requestId:'chunk-close',agentId:'root',text:'no late send',attachments:[file]});await g.entered.promise;
  c.ws.close();await once(c.ws,'close');await pause(10);g.release.resolve();
  await until(()=>f.calls.some(x=>x.method==='attachment.abort'));assert.ok(!f.calls.some(x=>x.method==='session.prompt'));assert.equal(f.native.length,0);
});

test('worktree FirstAgentContext is explicitly refused in native response before host mutation', {skip}, async t=> {
  const f=await fixture(t),c=await f.connect(),file=await f.upload(c);
  for (const [i,context] of [ {firstAgentContext:{prompt:'name this'}}, {firstAgentContext:{attachments:[file]}}, {attachments:[file]}, {nameContext:'legacy naming'} ].entries()) {
    c.send({type:'create_paseo_worktree_request',requestId:'ctx'+i,cwd:f.project,...context});
    const reply=await c.take('create_paseo_worktree_response','ctx'+i);assert.equal(reply.payload.workspace,null);assert.equal(reply.payload.setupTerminalId,null);assert.match(reply.payload.error,/first-agent context/);
  }
  assert.ok(!f.calls.some(x=>['workspace.worktree.create','attachment.begin','session.prompt'].includes(x.method)));
  c.send({type:'create_paseo_worktree_request',requestId:'no-context',cwd:f.project});
  const reply=await c.take('create_paseo_worktree_response','no-context');assert.equal(reply.payload.workspace,null);assert.match(reply.payload.error,/approve exactly one destination mapping/);
  assert.ok(f.calls.some(x=>x.method==='workspace.worktree.options'),'context-free request reaches existing authorized worktree RPC');
});


test('concurrent same-message conversions serialize before daemon upload and make one native turn', {skip}, async t => {
  const f=await fixture(t),c=await f.connect(),file=await f.upload(c);const g=f.block('attachment.begin');
  t.after(()=>g.release.resolve());
  const prompt={type:'send_agent_message_request',agentId:'root',text:'same concurrent message',messageId:'concurrent',attachments:[file]};
  c.send({...prompt,requestId:'one'});await g.entered.promise;c.send({...prompt,requestId:'two'});await pause(20);
  assert.equal(f.calls.filter(x=>x.method==='attachment.begin').length,1,'second conversion has not begun another upload');
  g.release.resolve();
  assert.equal((await c.take('send_agent_message_response','one')).payload.error,null);
  assert.equal((await c.take('send_agent_message_response','two')).payload.error,null);
  await until(()=>f.native.length===1);await pause(20);assert.equal(f.native.length,1);assert.ok(!f.calls.some(x=>x.method==='attachment.abort'));
});


test('workspace first-agent file is authorized before mutation and delivered as attachment-only prompt', {skip}, async t=> {
  const f=await fixture(t),c=await f.connect(),other=await f.connect(),file=await f.upload(c);
  const request={type:'workspace.create.request',source:{kind:'directory',path:f.project},agent:{config:{provider:'alp',cwd:f.project},attachments:[file],labels:{}}};
  const before=f.calls.filter(x=>x.method==='workspace.registry.mutate').length;
  other.send({...request,requestId:'foreign-workspace'});
  const refused=await other.take('workspace.create.response','foreign-workspace');assert.equal(refused.payload.workspace,null);assert.match(refused.payload.error,/not uploaded/);
  assert.equal(f.calls.filter(x=>x.method==='workspace.registry.mutate').length,before);
  c.send({...request,requestId:'workspace-file'});
  const made=await c.take('workspace.create.response','workspace-file');assert.equal(made.payload.error,null);assert.ok(made.payload.agent?.id);
  await until(()=>f.native.length===1);assert.ok(f.native[0].input.some(x=>x.type==='text'&&x.text.startsWith(ATTACHMENT_HEADER)));
});
