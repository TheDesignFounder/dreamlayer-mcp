import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedClient} from '../dist/client.js';
import {callTool} from '../dist/tools.js';
const eid='22222222-2222-4222-8222-222222222222';

test('bounded tool interval preserves cursor and returns continuation without resubmission', async()=>{
 let submissions=0;
 const server=http.createServer((req,res)=>{
  if(!req.url.endsWith('/events')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({execution_id:eid,status:'running'}));return;}
  assert.equal(req.headers['last-event-id'],'42');
  if(req.method==='POST')submissions++;
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': keepalive\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api=new ManagedClient('dlr_live_fixture',`http://127.0.0.1:${server.address().port}`);
  const start=Date.now();
  const result=await callTool(api,'dreamlayer_events',{execution_id:eid,last_event_id:'42'});
  const data=JSON.parse(result.content[0].text);
  assert.equal(data.status,'running');assert.equal(data.execution_id,eid);assert.equal(data.last_event_id,'42');
  assert.match(data.next_step,/dreamlayer_events/);assert.equal(submissions,0);assert.ok(Date.now()-start<25_000);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('owned bundle download refuses an existing path', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sprite-mcp-'));const target=join(dir,'walk.zip');
 const api={getExecution:async()=>({status:'completed',image_job:{finished_assets:[{download_url:'https://example.test/owned'}]}}),download:async()=>Buffer.from('owned bundle')};
 try{
  const first=await callTool(api,'dreamlayer_download',{execution_id:eid,path:target});
  assert.ok(!first.isError);assert.equal(await readFile(target,'utf8'),'owned bundle');
  const second=await callTool(api,'dreamlayer_download',{execution_id:eid,path:target});assert.ok(second.isError);
  assert.equal(await readFile(target,'utf8'),'owned bundle');
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('canonical completion recovers an absent terminal event', async()=>{
 const api={events:async function*(){}, getExecution:async()=>({status:'completed',image_job:{finished_assets:[{asset_id:eid,download_url:'https://example.test/bundle.zip'}]}})};
 const result=await callTool(api,'dreamlayer_events',{execution_id:eid,last_event_id:'99'});
 const data=JSON.parse(result.content[0].text);
 assert.equal(data.status,'completed');assert.equal(data.asset.asset_id,eid);assert.equal(data.last_event_id,'99');assert.ok(!data.next_step);
});


test('status lookup failure retains the execution and cursor', async()=>{
 const api={events:async function*(){},getExecution:async()=>{throw new Error('status unavailable');}};
 const result=await callTool(api,'dreamlayer_events',{execution_id:eid,last_event_id:'42'});
 const data=JSON.parse(result.content[0].text);
 assert.equal(data.status,'running');assert.equal(data.execution_id,eid);assert.equal(data.last_event_id,'42');assert.match(data.next_step,/dreamlayer_events/);
});

test('canonical status body has a ten second read bound', async()=>{
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api=new ManagedClient('dlr_live_fixture',`http://127.0.0.1:${server.address().port}`);
  const started=Date.now();
  await assert.rejects(api.getExecution(eid));
  assert.ok(Date.now()-started<20_000);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
