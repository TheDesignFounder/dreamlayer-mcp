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
