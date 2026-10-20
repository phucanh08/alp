import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';
let world;
test.beforeAll(async()=>{world=await startWorld();});
test.afterAll(async()=>{await world?.close();});
test('register a granted project, two clients share durable pin after daemon restart; default credential explains missing permission',async({browser,page})=>{
 await connect(page,world,world.tokens.registryWriter);
 await page.getByRole('button',{name:'Add project',exact:true}).click();
 await page.getByLabel('Existing granted directory').selectOption(world.projects.main);
 await page.getByRole('button',{name:'Register project',exact:true}).click();
 const row=page.getByTestId('shared-workspace-row').filter({hasText:'shop'});await expect(row).toHaveCount(1);
 const id=await row.getAttribute('data-workspace-id');
 const {connect:hostConnect}=await import('@anhlp/alp-client');const owner=await hostConnect(world.socket);let alternateId;
 try{const original=await owner.request('workspace.get',{workspaceId:id});const made=await owner.request('registry.owner',{operation:'workspace.create',args:{directory:world.projects.main,projectId:original.workspace.projectId,title:'Alternate workspace'},requestId:'second-workspace'});alternateId=made.result.workspace.id;}finally{owner.close();}
 await expect(page.getByTestId('shared-workspace-row')).toHaveCount(2,{timeout:30000});
 const second=await browser.newContext();const other=await second.newPage();
 try {
  await connect(other,world,world.tokens.registryWriter);await expect(other.getByTestId('shared-workspace-row')).toHaveCount(2);await expect(other.getByTestId('shared-workspace-row').filter({hasText:'shop'})).toHaveAttribute('data-workspace-id',id);
  await row.getByRole('button',{name:/^Pin workspace/}).click();await expect(row.getByRole('button',{name:/^Unpin workspace/})).toHaveAttribute('aria-pressed','true');
  await expect(other.getByTestId('shared-workspace-row').filter({hasText:'shop'}).getByRole('button',{name:/^Unpin workspace/})).toHaveAttribute('aria-pressed','true',{timeout:30000});
  const alternate=other.locator(`[data-workspace-id="${alternateId}"]`);await alternate.getByRole('button',{name:'Pin workspace Alternate workspace',exact:true}).click();await expect(alternate.getByRole('button',{name:'Unpin workspace Alternate workspace',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(row.getByRole('button',{name:/^Unpin workspace/})).toHaveAttribute('aria-pressed','true');
  await alternate.getByRole('button',{name:'Unpin workspace Alternate workspace',exact:true}).click();await expect(alternate.getByRole('button',{name:'Pin workspace Alternate workspace',exact:true})).toHaveAttribute('aria-pressed','false');
  await world.restartDaemon();await connect(page,world,world.tokens.registryWriter);await expect(row).toHaveAttribute('data-workspace-id',id);await expect(page.locator(`[data-workspace-id="${alternateId}"]`)).toBeVisible();await expect(page.getByRole('button',{name:/^Unpin workspace/})).toHaveAttribute('aria-pressed','true');await page.screenshot({path:test.info().outputPath('shared-pins-after-restart.png')});
 } finally {await second.close();}
 const defaults=await browser.newContext();const read=await defaults.newPage();try{await connect(read,world);await read.getByRole('button',{name:'Add project',exact:true}).click();await expect(read.getByRole('status').filter({hasText:'workspace.write'})).toContainText('host owner');}finally{await defaults.close();}
});

test('real gateway and daemon filter before page/count and deny outside grants without registry or credential writes; removed/archived mutations replay',async()=>{
 const {connect:hostConnect}=await import('@anhlp/alp-client');
 const {AlpRpcClient,hello}=await import('@anhlp/alp-client/portable');
 const {connectWebSocket}=await import('@anhlp/alp-client/websocket');
 const {readFile}=await import('node:fs/promises');
 const assert=(await import('node:assert/strict')).default;
 const owner=await hostConnect(world.socket);let remote;
 try {
  let current=await owner.request('project.list',{});
  const hidden=await owner.request('project.register',{directory:world.projects.other,ifRevision:current.revision,requestId:'hidden'});
  const all=await owner.request('workspace.list',{});const outside=all.workspaces.find(w=>w.projectId===hidden.project.id);
  const ticket=await fetch(world.gatewayUrl+'/v1/tickets',{method:'POST',headers:{authorization:'Bearer '+world.tokens.registryWriter}});const body=await ticket.json();
  remote=new AlpRpcClient(await connectWebSocket(world.gatewayUrl.replace('http:','ws:')+'/v1/ws',{protocols:body.subprotocols}));await hello(remote);
  const page=await remote.request('workspace.list',{limit:1});assert.equal(page.total,2);assert.ok(page.nextCursor);const next=await remote.request('workspace.list',{limit:1,cursor:page.nextCursor});assert.equal(next.workspaces.length,1);assert.equal(next.nextCursor,null);assert.notEqual(next.workspaces[0].id,page.workspaces[0].id);assert.notEqual(next.workspaces[0].id,outside.id);assert.equal(page.workspaces.length,1);assert.notEqual(page.workspaces[0].id,outside.id);assert.equal(page.workspaces[0].canonical,undefined);
  const file=world.home+'/state/web-workspaces.json';const before=await readFile(file,'utf8');const credentialFile=world.directory+'/gateway/credentials.json';const credentialsBefore=await readFile(credentialFile,'utf8');
  for(const [method,params]of[
   ['project.register',{directory:world.projects.other,ifRevision:page.revision,requestId:'denied'}],
   ['workspace.update',{workspaceId:outside.id,pinned:true,ifRevision:page.revision,requestId:'denied'}],
   ['project.remove',{projectId:hidden.project.id,ifRevision:page.revision,requestId:'denied'}],
  ])await assert.rejects(remote.request(method,params),e=>e.code===1003);
  assert.equal(await readFile(file,'utf8'),before);assert.equal(await readFile(credentialFile,'utf8'),credentialsBefore);
  const own=page.workspaces[0];const archive={workspaceId:own.id,archived:true,ifRevision:page.revision,requestId:'archive-real'};const archived=await remote.request('workspace.update',archive);assert.deepEqual(await remote.request('workspace.update',archive),archived);
  const remove={projectId:own.projectId,ifRevision:archived.revision,requestId:'remove-real'};const removed=await remote.request('project.remove',remove);assert.deepEqual(await remote.request('project.remove',remove),removed);
 } finally {remote?.close();owner.close();}
});
