import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';
let world;
test.beforeAll(async()=>{world=await startWorld();});
test.afterAll(async()=>{await world?.close();});
test('register a granted project, two clients share durable pin after daemon restart; default credential explains missing permission',async({browser,page})=>{
 await connect(page,world,world.tokens.registryWriter);
 // Paseo's footer Add project, for ALP: register a directory the token grants.
 await page.getByTestId('sidebar-add-project').click();
 await page.getByLabel('Existing granted directory').selectOption(world.projects.main);
 await page.getByRole('button',{name:'Register project',exact:true}).click();
 const project=target=>target.locator(`[data-testid="sidebar-project"][data-path="${world.projects.main}"]`);
 const row=project(page);await expect(row).toHaveAttribute('data-workspace-id',/.+/);
 const id=await row.getAttribute('data-workspace-id');
 const {connect:hostConnect}=await import('@anhlp/alp-client');const owner=await hostConnect(world.socket);let alternateId;
 try{const original=await owner.request('workspace.get',{workspaceId:id});const made=await owner.request('registry.owner',{operation:'workspace.create',args:{directory:world.projects.main,projectId:original.workspace.projectId,title:'Alternate workspace'},requestId:'second-workspace'});alternateId=made.result.workspace.id;}finally{owner.close();}
 const second=await browser.newContext();const other=await second.newPage();
 const pin=async(target,testId)=>{await project(target).getByTestId('project-row').hover();await project(target).getByTestId('project-actions').click();await target.getByTestId(testId).click();};
 try {
  await connect(other,world,world.tokens.registryWriter);await expect(project(other)).toHaveAttribute('data-workspace-id',id);
  // Pin to top from the project's actions: the project moves to Paseo's Pinned section, for every client.
  await pin(page,'project-pin');await expect(row).toHaveAttribute('data-pinned','true');await expect(page.getByTestId('sidebar-pinned')).toContainText('shop');
  await expect(project(other)).toHaveAttribute('data-pinned','true',{timeout:30000});
  // The second record of the same directory is pinned from Settings › Workspaces; the project's own pin stays.
  await other.getByTestId('sidebar-settings').click();const settings=other.getByRole('region',{name:'Settings'});await settings.getByTestId('settings-workspaces').click();
  const alternate=settings.locator(`[data-workspace-id="${alternateId}"]`);await alternate.getByRole('button',{name:'Pin workspace Alternate workspace',exact:true}).click();await expect(alternate.getByRole('button',{name:'Unpin workspace Alternate workspace',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(row).toHaveAttribute('data-pinned','true');
  await alternate.getByRole('button',{name:'Unpin workspace Alternate workspace',exact:true}).click();await expect(alternate.getByRole('button',{name:'Pin workspace Alternate workspace',exact:true})).toHaveAttribute('aria-pressed','false');
  await world.restartDaemon();await connect(page,world,world.tokens.registryWriter);await expect(row).toHaveAttribute('data-workspace-id',id);await expect(row).toHaveAttribute('data-pinned','true');await page.screenshot({path:test.info().outputPath('shared-pins-after-restart.png')});
  await pin(page,'project-unpin');await expect(row).not.toHaveAttribute('data-pinned','true');await expect(page.getByTestId('sidebar-pinned')).toHaveCount(0);
 } finally {await second.close();}
 const defaults=await browser.newContext();const read=await defaults.newPage();try{await connect(read,world);await read.getByTestId('sidebar-add-project').click();await expect(read.getByRole('status').filter({hasText:'workspace.write'})).toContainText('host owner');}finally{await defaults.close();}
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
