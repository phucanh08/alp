import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRegistry } from '@anhlp/alp-daemon/registry';
async function setup(t) { const root = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-registry-test-'))); t.after(() => rm(root, { recursive: true, force: true })); const home = path.join(root, 'home'); const directory = path.join(root, 'project'); await mkdir(directory); return { root, home, directory }; }
test('migration retains complete legacy IDs, labels, pins, placement and exact backup; private modes', async t => {
 const { home, directory } = await setup(t); await mkdir(path.join(home,'state'),{recursive:true});
 const legacy = { projects:[{id:'prj_0000000000000001',root:directory,customName:'Custom',addedAt:'old'}],workspaces:[{id:'wks_0000000000000001',projectId:'prj_0000000000000001',directory,title:'Title',pinnedAt:'pin',labels:['Bug'],createdAt:'old',idempotencyKey:'key'}],sessions:{s:'wks_0000000000000001'},labels:{generation:'gen',seq:8,catalog:[{name:'Bug',color:'red'}]} };
 const text = JSON.stringify(legacy); const file=path.join(home,'state/web-workspaces.json'); await writeFile(file,text);
 const r=await createRegistry(home).snapshot(); assert.equal(r.workspaces[0].pinnedAt,'pin'); assert.deepEqual(r.sessions,legacy.sessions); assert.deepEqual(r.labels,legacy.labels); assert.equal(r.projects[0].customName,'Custom'); assert.equal(r.workspaces[0].idempotencyKey,'key'); assert.equal(await readFile(file+'.legacy-v0.json','utf8'),text); if (process.platform !== 'win32') { assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700); }
});
test('write failure does not acknowledge, publish a revision or consume the request; retry survives restart',async t=>{
 const {home,directory}=await setup(t); let broken=false;
 const r=createRegistry(home,{write:async (...args)=>{if(broken) throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});return writeFile(...args);}});
 const made=await r.mutate('project.register',{directory},{requestId:'register',ifRevision:0}); const before=await r.snapshot(); const id=before.workspaces[0].id;
 broken=true;await assert.rejects(r.mutate('workspace.update',{workspaceId:id,pinned:true},{requestId:'pin',ifRevision:made.revision}),/ENOSPC/);assert.deepEqual(await r.snapshot(),before);
 broken=false;const pinned=await r.mutate('workspace.update',{workspaceId:id,pinned:true},{requestId:'pin',ifRevision:made.revision});assert.ok(pinned.workspace.pinnedAt);
 const restarted=createRegistry(home);assert.deepEqual(await restarted.mutate('workspace.update',{workspaceId:id,pinned:true},{requestId:'pin',ifRevision:made.revision}),pinned);assert.equal((await restarted.snapshot()).revision,pinned.revision);
 await assert.rejects(restarted.mutate('workspace.update',{workspaceId:id,pinned:false},{requestId:'pin',ifRevision:made.revision}),{data:{reason:'request_conflict'}});
});
test('CAS races have exactly one winner; canonical aliases register once; corrupt bytes retained',async t=>{
 const {home,directory,root}=await setup(t);const r=createRegistry(home);await r.mutate('project.register',{directory},{requestId:'a',ifRevision:0});const a=await r.snapshot();const workspaceId=a.workspaces[0].id;
 const results=await Promise.allSettled([true,false].map((pinned,i)=>r.mutate('workspace.update',{workspaceId,pinned},{requestId:'race'+i,ifRevision:a.revision})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const alias=path.join(root,'alias');await symlink(directory,alias,process.platform === 'win32' ? 'junction' : 'dir');await r.mutate('project.register',{directory:alias},{requestId:'alias'});assert.equal((await r.snapshot()).projects.length,1);assert.equal((await r.snapshot()).workspaces.length,1);
 const file=path.join(home,'state/web-workspaces.json');await writeFile(file,'{broken');await assert.rejects(createRegistry(home).snapshot(),{data:{reason:'corrupt_registry'}});assert.equal(await readFile(file,'utf8'),'{broken');
});
test('receipts are immutable snapshots across later mutations; prepare is a read when placement unchanged',async t=>{
 const {home,directory}=await setup(t);const r=createRegistry(home);await r.mutate('project.register',{directory},{requestId:'r'});const before=await r.snapshot();const workspaceId=before.workspaces[0].id;
 const pinned=await r.mutate('workspace.update',{workspaceId,pinned:true},{requestId:'pin',ifRevision:before.revision});
 await r.mutate('workspace.update',{workspaceId,title:'Later'},{requestId:'title',ifRevision:pinned.revision});
 assert.deepEqual(await r.mutate('workspace.update',{pinned:true,workspaceId},{requestId:'pin',ifRevision:before.revision}),pinned);
 await r.mutate('placement.prepare',{sessions:[{id:'s',projectRoot:directory}]},{requestId:'prepare'});const prepared=await r.snapshot();
 await r.mutate('placement.prepare',{sessions:[{id:'s',projectRoot:directory}]},{requestId:'again'});assert.deepEqual(await r.snapshot(),prepared);
});
test('duplicate legacy canonical aliases keep both identities and placements; malformed schema is retained',async t=>{
 const {home,directory,root}=await setup(t);const alias=path.join(root,'alias');await symlink(directory,alias,process.platform === 'win32' ? 'junction' : 'dir');
 const legacy={projects:[{id:'prj_0000000000000001',root:directory,addedAt:'old'},{id:'prj_0000000000000002',root:alias,addedAt:'old'}],workspaces:[{id:'wks_0000000000000001',projectId:'prj_0000000000000001',directory,labels:[],createdAt:'old'},{id:'wks_0000000000000002',projectId:'prj_0000000000000002',directory:alias,pinnedAt:'pin',labels:[],createdAt:'old'}],sessions:{s1:'wks_0000000000000001',s2:'wks_0000000000000002'},labels:{generation:'g',seq:0,catalog:[]}};
 await mkdir(path.join(home,'state'),{recursive:true});const file=path.join(home,'state/web-workspaces.json');await writeFile(file,JSON.stringify(legacy));const r=createRegistry(home);await r.mutate('project.register',{directory:alias},{requestId:'alias'});const migrated=await r.snapshot();assert.equal(migrated.projects.length,2);assert.deepEqual(migrated.sessions,legacy.sessions);assert.equal(migrated.workspaces[1].pinnedAt,'pin');
 for(const bad of [{...migrated,version:999},{...migrated,labels:{...migrated.labels,catalog:[{name:'Bad',color:'not-a-color'}]}},{...migrated,receipts:null},{...migrated,revision:undefined},{...migrated,workspaces:[{...migrated.workspaces[0],labels:undefined}]},{...migrated,sessions:{s:'missing'}},{...migrated,projects:[{...migrated.projects[0],canonical:42}]}]){const text=JSON.stringify(bad);await writeFile(file,text);await assert.rejects(createRegistry(home).snapshot(),{data:{reason:'corrupt_registry'}});assert.equal(await readFile(file,'utf8'),text);}
});
test('scoped remove checks archived foreign legacy workspace before replay or any write',async t=>{
 const {home,directory,root}=await setup(t);const outside=path.join(root,'outside');await mkdir(outside);const r=createRegistry(home);const registered=await r.mutate('project.register',{directory},{requestId:'r'});
 const foreign=await r.mutate('workspace.create',{directory:outside,projectId:registered.project.id},{requestId:'foreign'});await r.mutate('workspace.update',{workspaceId:foreign.workspace.id,archived:true},{requestId:'archive'});const before=await r.snapshot();
 await assert.rejects(r.mutate('project.remove',{projectId:registered.project.id},{requestId:'remove',ifRevision:before.revision,allowedRoots:[await realpath(directory)]}),{data:{reason:'outside_workspace'}});assert.deepEqual(await r.snapshot(),before);
});

test('valid session IDs that resemble Object keys retain explicit placement',async t=>{
 const {home,directory}=await setup(t);const r=createRegistry(home);await r.mutate('placement.prepare',{sessions:[{id:'__proto__',projectRoot:directory},{id:'constructor',projectRoot:directory}]},{requestId:'place'});const s=await r.snapshot();for(const id of ['__proto__','constructor']){assert.ok(Object.hasOwn(s.sessions,id));assert.equal(s.sessions[id],s.workspaces[0].id);}assert.deepEqual((await createRegistry(home).snapshot()).sessions,s.sessions);
});

for (const status of ['archived', 'closed', 'error', 'running']) test(`historical ${status} missing roots retain mapped placement and persist unmapped placement`, async t => {
 const {home,directory,root}=await setup(t);const r=createRegistry(home);
 await r.mutate('placement.prepare',{sessions:[{id:'mapped',projectRoot:directory}]},{requestId:'seed'});
 const before=await r.snapshot(); await rm(directory,{recursive:true});
 const archived=status==='archived';
 const sessions=[{id:'mapped',projectRoot:directory,archived,status},{id:'unmapped',projectRoot:path.join(root,'never-existed'),archived,status}];
 await r.mutate('placement.prepare',{sessions},{requestId:'historical'});
 const after=await r.snapshot();assert.equal(after.sessions.mapped,before.sessions.mapped);assert.deepEqual(after.workspaces[0],before.workspaces[0]);
 assert.ok(after.sessions.unmapped);assert.equal(after.workspaces.find(w=>w.id===after.sessions.unmapped).directory,sessions[1].projectRoot);
 const restarted=createRegistry(home);await restarted.mutate('placement.prepare',{sessions},{requestId:'restart'});assert.deepEqual(await restarted.snapshot(),after);
 await assert.rejects(restarted.resolve(after.sessions.mapped));await assert.rejects(restarted.resolve(after.sessions.unmapped,undefined,true));
});

test('live mapped aliases cannot silently rebind to a different canonical target', async t => {
 const {home,directory,root}=await setup(t);const alias=path.join(root,'alias');await symlink(directory,alias,'dir');const r=createRegistry(home);
 await r.mutate('placement.prepare',{sessions:[{id:'live',projectRoot:alias}]},{requestId:'seed'});const before=await r.snapshot();
 const other=path.join(root,'other');await mkdir(other);await rm(alias);await symlink(other,alias,'dir');
 await r.mutate('placement.prepare',{sessions:[{id:'live',projectRoot:alias}]},{requestId:'retarget'});assert.deepEqual(await r.snapshot(),before);
 await assert.rejects(r.resolve(before.sessions.live),{data:{reason:'identity_changed'}});
});

for (const archived of [true, false]) test(`unmapped missing ${archived ? 'archived' : 'closed'} root is discoverable without live identity`, async t => {
 const {home,root}=await setup(t);const r=createRegistry(home);const projectRoot=path.join(root,'missing');
 await r.mutate('placement.prepare',{sessions:[{id:'old',projectRoot,archived,status:'closed'}]},{requestId:'discover'});
 const after=await r.snapshot();assert.equal(after.workspaces[0].directory,projectRoot);assert.equal(after.sessions.old,after.workspaces[0].id);
 await createRegistry(home).mutate('placement.prepare',{sessions:[{id:'old',projectRoot,archived,status:'closed'}]},{requestId:'again'});
 assert.deepEqual(await createRegistry(home).snapshot(),after);
});

for (const archived of [true, false]) test(`historical ${archived ? 'archived' : 'closed'} existing alias resolves until actually retargeted`, async t => {
 const {home,root,directory}=await setup(t);const alias=path.join(root,'history-alias');await symlink(directory,alias,'dir');const r=createRegistry(home);
 await r.mutate('placement.prepare',{sessions:[{id:'history',projectRoot:alias,archived,status:'closed'}]},{requestId:'history'});
 const before=await r.snapshot();const id=before.sessions.history;
 assert.equal(await r.resolve(id,undefined,true),await realpath(directory));
 const restarted=createRegistry(home);assert.equal(await restarted.resolve(id,undefined,true),await realpath(directory));
 const other=path.join(root,'other');await mkdir(other);await rm(alias);await symlink(other,alias,'dir');
 await restarted.mutate('placement.prepare',{sessions:[{id:'history',projectRoot:alias,archived,status:'closed'}]},{requestId:'retarget'});
 assert.deepEqual(await restarted.snapshot(),before);
 await assert.rejects(restarted.resolve(id,undefined,true),{data:{reason:'identity_changed'}});
});

for (const archived of [true, false]) test(`historical ${archived ? 'archived' : 'closed'} missing identity remains unknown when directory appears`, async t => {
 const {home,root,directory}=await setup(t);const alias=path.join(root,'future-alias');const r=createRegistry(home);
 await r.mutate('placement.prepare',{sessions:[{id:'history',projectRoot:alias,archived,status:'closed'}]},{requestId:'history'});
 const before=await r.snapshot();assert.equal(before.workspaces[0].canonical,undefined);assert.equal(before.projects[0].canonical,undefined);
 // When it appears as an alias, resolving rejects with identity_changed (matching sourceOf and describe)
 await symlink(directory,alias,'dir');let restarted=createRegistry(home);
 await assert.rejects(restarted.resolve(before.sessions.history,undefined,true),{data:{reason:'identity_changed'}});
 // When it appears as its own canonical directory, it resolves without inventing canonical in persisted history
 await rm(alias);await mkdir(alias);restarted=createRegistry(home);
 assert.equal(await restarted.resolve(before.sessions.history,undefined,true),alias);
 assert.deepEqual(await restarted.snapshot(),before);
});

test('legacy record without canonical resolves at its own canonical path and rejects through an alias', async t => {
 const {home,root,directory}=await setup(t);const alias=path.join(root,'alias');await symlink(directory,alias,process.platform === 'win32' ? 'junction' : 'dir');
 const legacy={version:1,revision:1,receipts:{},projects:[{id:'prj_0000000000000001',root:directory,addedAt:'old'},{id:'prj_0000000000000002',root:alias,addedAt:'old'}],workspaces:[{id:'wks_0000000000000001',projectId:'prj_0000000000000001',directory,labels:[],createdAt:'old'},{id:'wks_0000000000000002',projectId:'prj_0000000000000002',directory:alias,labels:[],createdAt:'old'}],sessions:{s1:'wks_0000000000000001',s2:'wks_0000000000000002'},labels:{generation:'g',seq:0,catalog:[]}};
 await mkdir(path.join(home,'state'),{recursive:true});const file=path.join(home,'state/web-workspaces.json');await writeFile(file,JSON.stringify(legacy));
 const r=createRegistry(home);
 assert.equal(await r.resolve('wks_0000000000000001'),directory);
 await assert.rejects(r.resolve('wks_0000000000000002'),{data:{reason:'identity_changed'}});
});
