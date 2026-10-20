import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { fakeDaemon } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';
import { DEFAULT_PERMISSIONS } from '../src/policy.js';

test('registry: exact existing grants, filtered pagination/count, explicit projection, opt-in writes and authorize before replay', async t => {
 const root=await mkdtemp(path.join(tmpdir(), 'alp-gw-registry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const a= root+'/a', b=root+'/b', alias=root+'/alias';await mkdir(a);await mkdir(b);await symlink(a,alias,process.platform === 'win32' ? 'junction' : 'dir');
 const ca=await realpath(a), cb=await realpath(b);let revision=0;let writes=0;
 const projects=[{id:'prj_b',root:cb,canonical:cb,addedAt:'old'},{id:'prj_a',root:ca,canonical:ca,addedAt:'old',ownerSecret:'hidden'}];
 const workspaces=[{id:'wks_b',projectId:'prj_b',directory:cb,canonical:cb,createdAt:'old',labels:[]},{id:'wks_a',projectId:'prj_a',directory:ca,canonical:ca,createdAt:'old',labels:[],placement:'hidden'}];
 const daemon=fakeDaemon();
 for(const [kind,entries] of [['project',projects],['workspace',workspaces]]) daemon.state.handlers[kind+'.list']=p=>{let rows=entries.filter(e=>!p.projectRoots||p.projectRoots.includes(e.root??e.directory));let offset=Number(p.cursor??0),limit=p.limit??100;return {[kind+'s']:rows.slice(offset,offset+limit),total:rows.length,revision,nextCursor:offset+limit<rows.length?String(offset+limit):null};};
 daemon.state.handlers['workspace.get']=p=>{const workspace=workspaces.find(w=>w.id===p.workspaceId);if(!workspace)throw{code:1001};return{workspace,revision};};
 daemon.state.handlers['project.register']=p=>{writes++;revision++;return{project:projects[1],revision};};
 daemon.state.handlers['workspace.update']=p=>{writes++;revision++;const w=workspaces.find(w=>w.id===p.workspaceId);w.pinnedAt=p.pinned?'pin':null;return{workspace:w,revision};};
 daemon.state.handlers['project.remove']=()=>{writes++;return{project:projects[1],revision:++revision};};
 const env=await startGateway(t,{daemon,credentials:{writer:{workspaces:[alias],permissions:['project.read','workspace.write']},reader:{workspaces:[a],permissions:['project.read']},defaults:{workspaces:[a]}}});
 const {client}=await env.sdk('writer');const reader=(await env.sdk('reader')).client;const defaults=(await env.sdk('defaults')).client;
 assert.ok(!DEFAULT_PERMISSIONS.includes('workspace.write'));
 for(const [method,params] of [['project.register',{directory:a,requestId:'r',ifRevision:0}],['workspace.update',{workspaceId:'wks_a',pinned:true,requestId:'r',ifRevision:0}],['project.remove',{projectId:'prj_a',requestId:'r',ifRevision:0}]]) {await assert.rejects(reader.request(method,params),e=>e.code===1003&&e.data.reason==='grant');await assert.rejects(defaults.request(method,params),e=>e.code===1003&&e.data.reason==='grant');}
 assert.equal(writes,0);
 const page=await client.request('workspace.list',{limit:1,projectRoots:[cb]});assert.deepEqual(page.workspaces.map(w=>w.id),['wks_a']);assert.equal(page.total,1);assert.equal(page.nextCursor,null);assert.equal(page.workspaces[0].canonical,undefined);assert.equal(page.workspaces[0].placement,undefined);
 assert.equal((await client.request('project.list',{})).projects[0].ownerSecret,undefined);
 await assert.rejects(client.request('project.register',{directory:b,ifRevision:0,requestId:'outside'}),e=>e.code===1003);assert.equal(writes,0);
 await assert.rejects(client.request('workspace.update',{workspaceId:'wks_b',pinned:true,ifRevision:0,requestId:'outside'}),e=>e.code===1003);assert.equal(writes,0);
 await assert.rejects(client.request('project.remove',{projectId:'prj_b',ifRevision:0,requestId:'outside'}),e=>e.code===1003);assert.equal(writes,0);
 await assert.rejects(client.request('registry.owner',{}),e=>e.code===-32601);
 const pinned=await client.request('workspace.update',{workspaceId:'wks_a',pinned:true,ifRevision:0,requestId:'pin'});assert.equal(pinned.workspace.pinnedAt,'pin');assert.equal(writes,1);
 await unlink(alias);await symlink(b,alias,process.platform === 'win32' ? 'junction' : 'dir');
 await assert.rejects(client.request('workspace.update',{workspaceId:'wks_a',pinned:true,ifRevision:0,requestId:'pin'}),e=>e.code===1003);assert.equal(writes,1,'retarget denied before replay');assert.equal((await client.request('workspace.list',{})).total,0);
});
