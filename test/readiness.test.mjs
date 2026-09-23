import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callTool, toolDefinitionsFor, resetOperationCache } from '../dist/tools.js';
import { StreamIdleError } from '../dist/client.js';

test('discovery annotates read effects without implying paid generation is idempotent', async () => {
  resetOperationCache();
  const definitions = await toolDefinitionsFor({ getCapabilities: async () => ({ operations: ['text_to_image'] }) });
  assert.equal(definitions.find(t => t.name === 'dreamlayer_execution').annotations.readOnlyHint, true);
  const generate = definitions.find(t => t.name === 'dreamlayer_generate');
  assert.equal(generate.annotations.readOnlyHint, false);
  assert.equal(generate.annotations.idempotentHint, false);
  assert.deepEqual(generate.inputSchema.properties.operation.enum, ['text_to_image']);
  assert.equal(definitions.find(t => t.name === 'dreamlayer_download').annotations.readOnlyHint, false);
});

test('generated recovery key and partial execution survive a broken stream in both result formats', async () => {
  let sent;
  const client = { execute: async function* (_input, { idempotencyKey }) {
    sent = idempotencyKey;
    yield { id: '1', event: 'started', data: { execution_id: 'owned-execution' } };
    throw new StreamIdleError();
  } };
  const result = await callTool(client, 'dreamlayer_generate', { operation: 'text_to_image', prompt: 'a tree' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.execution_id, 'owned-execution');
  assert.equal(result.structuredContent.error.idempotency_key, sent);
  assert.ok(sent);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.match(result.structuredContent.error.guidance, /dreamlayer_execution/);
});

test('structured success retains text compatibility', async () => {
  const result = await callTool({ getBalance: async () => ({ available: 2 }) }, 'dreamlayer_balance', {});
  assert.deepEqual(result.structuredContent, { available: 2 });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

for (const state of ['running', 'completed', 'unavailable']) {
  test(`abrupt stream reset reconciles canonical ${state} without resubmission`, async () => {
    let submits = 0, reads = 0;
    const client = {
      execute: async function* () { submits++; yield {id: 'cursor', event: 'started', data: {execution_id: 'owned'}}; throw new TypeError('socket reset PRIVATE'); },
      getExecution: async id => { reads++; assert.equal(id, 'owned'); if (state === 'unavailable') throw new Error('offline'); return {status: state, image_job: state === 'completed' ? {finished_assets: [{asset_id: 'asset', download_url: 'https://api.dreamlayer.io/asset'}]} : null}; }
    };
    const result = await callTool(client, 'dreamlayer_generate', {prompt: 'a tree', idempotency_key: 'saved'});
    assert.equal(submits, 1); assert.equal(reads, 1);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.doesNotMatch(result.content[0].text, /PRIVATE/);
    if (state === 'completed') {
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.status, 'completed');
      assert.equal(result.structuredContent.idempotency_key, 'saved');
    } else {
      const error = result.structuredContent.error;
      assert.equal(error.reason, 'temporarily_unavailable'); assert.equal(error.retryable, true);
      assert.equal(error.execution_id, 'owned'); assert.equal(error.last_event_id, 'cursor');
      assert.equal(error.idempotency_key, 'saved'); assert.match(error.guidance, /dreamlayer_execution/);
    }
  });
}

test('download write refusal keeps execution identity and never describes generation as failed', async () => {
  const {mkdtemp, writeFile, readFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-download-'));
  const target = join(dir, 'existing.png'); await writeFile(target, 'original');
  const result = await callTool({getExecution: async () => ({status: 'completed', image_job: {finished_assets: [{download_url: 'asset'}]}}), download: async () => Buffer.from('new')}, 'dreamlayer_download', {execution_id: 'owned', path: target});
  assert.equal(result.structuredContent.error.reason, 'local_output_failed');
  assert.equal(result.structuredContent.error.execution_id, 'owned');
  assert.equal(result.structuredContent.error.retryable, true);
  assert.match(result.structuredContent.error.guidance, /dreamlayer_download/);
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('sprite validation returns actionable errors before transport', async () => {
  const {ManagedClient} = await import('../dist/client.js');
  const client = new ManagedClient('unused', 'http://127.0.0.1:1');
  for (const [extra, pattern] of [[{max_credits: 1}, /5.8 credits/], [{options: {action:'walk', frame_count:7, frame_size:33}}, /frame_size/]]) {
    const result = await callTool(client, 'dreamlayer_generate', {operation:'sprite_sheet', input_asset_id:'owned', options:{action:'walk', frame_count:7}, max_credits:5.8, ...extra});
    assert.equal(result.structuredContent.error.reason, 'invalid_request');
    assert.equal(result.structuredContent.error.retryable, false);
    assert.match(result.structuredContent.error.message, pattern);
  }
});

test('SDK client validates structured successes and errors against discovered output schemas', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const backend = {
    getCapabilities: async () => ({api_version: '1', operations: ['text_to_image']}),
    getBalance: async () => ({available: 2}),
    execute: async function* () { yield {id:'one',event:'started',data:{execution_id:'owned'}}; yield {id:'two',event:'done',data:{status:'completed'}}; }
  };
  resetOperationCache();
  const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: await toolDefinitionsFor(backend)}));
  server.setRequestHandler(CallToolRequestSchema, async req => callTool(backend, req.params.name, req.params.arguments ?? {}));
  const client = new Client({name:'fixture-client',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b); await client.listTools();
    for (const request of [
      {name:'dreamlayer_balance',arguments:{}},
      {name:'dreamlayer_generate',arguments:{prompt:'a tree'}},
      {name:'dreamlayer_download',arguments:{execution_id:'owned',path:'relative.png'}}
    ]) {
      const result = await client.callTool(request);
      assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
      if (request.name === 'dreamlayer_generate') assert.ok(result.structuredContent.idempotency_key);
      if (request.name === 'dreamlayer_download') assert.equal(result.isError,true);
    }
  } finally { await client.close(); await server.close(); }
});

for (const invalid of [
  'event: progress\ndata: {"text":"ok","private":"DO_NOT_ECHO"}\n\n',
  'event: progress\ndata: {DO_NOT_ECHO\n\n',
  'event: unexpected\ndata: {"private":"DO_NOT_ECHO"}\n\n',
]) {
  test(`wire contract violation is permanent and retains recovery: ${invalid.split('\n')[0]} ${invalid.length}`, async () => {
    const {createServer}=await import('node:http');
    const {ManagedClient}=await import('../dist/client.js');
    const requests=[];
    const id='22222222-2222-4222-8222-222222222222';
    const server=createServer((req,res)=>{
      requests.push(req.method+' '+req.url);
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(`id: first\nevent: started\ndata: ${JSON.stringify({execution_id:id,conversation_id:'33333333-3333-4333-8333-333333333333'})}\n\n`+invalid);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const result=await callTool(new ManagedClient('fake',`http://127.0.0.1:${server.address().port}`),'dreamlayer_generate',{prompt:'a tree',idempotency_key:'saved'});
      const error=result.structuredContent.error;
      assert.equal(result.isError,true); assert.equal(error.reason,'response_contract_error');
      assert.equal(error.retryable,false);assert.equal(error.execution_id,id);assert.equal(error.idempotency_key,'saved');
      assert.equal(error.last_event_id,'first');assert.doesNotMatch(result.content[0].text,/DO_NOT_ECHO/);
      assert.deepEqual(requests,['POST /v1/execute']);
    } finally {await new Promise(resolve=>server.close(resolve));}
  });
}
test('unknown collection failure is not converted into a transient outage',async()=>{
  const result=await callTool({execute:async function*(){yield {id:'cursor',event:'started',data:{execution_id:'owned'}};throw new Error('private implementation failure');}},'dreamlayer_generate',{prompt:'a tree',idempotency_key:'saved'});
  assert.equal(result.structuredContent.error.reason,'client_error');
  assert.equal(result.structuredContent.error.retryable,false);
  assert.equal(result.structuredContent.error.execution_id,'owned');
  assert.doesNotMatch(result.content[0].text,/private implementation/);
});

test('documented failed done event accepts its error object without exposing upstream text', async () => {
  const {managedEvent}=await import('../dist/client.js');
  const event=managedEvent('done','last',{status:'failed',error:{reason:'insufficient_credits',message:'PRIVATE upstream detail',retryable:false}});
  assert.equal(event.data.error.reason,'insufficient_credits');
  assert.equal(event.data.error.retryable,false);
  assert.doesNotMatch(JSON.stringify(event),/PRIVATE/);
});
