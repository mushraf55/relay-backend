import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embed, answer, streamAnswer, chunkText, KNOWLEDGE_CHUNK_OVERLAP, KNOWLEDGE_CHUNK_SIZE } from '../src/features/ai/client.js';
import { isMeteredAiPath } from '../src/features/ai/routes.js';
import { groundedChat } from '../src/features/ai/chat-service.js';
const settings = { provider: 'ollama', base: 'http://localhost:11434', embedding: 'local-embedding', chat: 'local-chat' };
test('chunking preserves overlap and the end of the source', () => {
  const text = 'x'.repeat(KNOWLEDGE_CHUNK_SIZE - 1) + 'THE_END';
  const chunks = chunkText(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].slice(-KNOWLEDGE_CHUNK_OVERLAP), chunks[1].slice(0,KNOWLEDGE_CHUNK_OVERLAP));
  assert.ok(chunks.at(-1).endsWith('THE_END'));
  assert.deepEqual(chunkText('   '), []);
});

test('progress checks do not consume the AI generation quota', () => {
  assert.equal(isMeteredAiPath('/status'), false);
  assert.equal(isMeteredAiPath('/status/source'), false);
  assert.equal(isMeteredAiPath('/train'), true);
  assert.equal(isMeteredAiPath('/chat'), true);
});
test('Ollama embeds batches and records model identity plus actual dimensions', async () => {
  const result = await embed(['one','two'], settings, async (url, options) => {
    assert.equal(url, 'http://localhost:11434/api/embed');
    assert.equal(JSON.parse(options.body).truncate, false);
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ embeddings: [[1,2,3],[4,5,6]] });
  });
  assert.equal(result.dimensions, 3); assert.equal(result.modelKey, 'ollama:local-embedding');
});
test('Cloudflare embeds through the Workers AI OpenAI-compatible endpoint', async () => {
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = 'cf_test_token';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
  try {
    const result = await embed(['one'], { ...settings, embeddingProvider: 'cloudflare', embeddingBase: 'https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1', embedding: '@cf/qwen/qwen3-embedding-0.6b' }, async (url, options) => {
      assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/embeddings');
      assert.equal(options.headers.Authorization, 'Bearer cf_test_token');
      assert.deepEqual(JSON.parse(options.body), { model: '@cf/qwen/qwen3-embedding-0.6b', input: ['one'] });
      return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    });
    assert.equal(result.dimensions, 3);
    assert.equal(result.modelKey, 'cloudflare:@cf/qwen/qwen3-embedding-0.6b');
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
  }
});
test('invalid or inconsistent vectors are rejected before storage', async () => {
  await assert.rejects(embed(['one','two'], settings, async () => Response.json({ embeddings:[[1,2],[3]] })), /invalid vectors/);
});
test('reasoning model only returns its final answer, not its thinking field', async () => {
  const result = await answer([{role:'user',content:'Hello'}], settings, async () => Response.json({ message: { content: 'Hello!', thinking: 'internal reasoning' } }));
  assert.equal(result, 'Hello!');
});
test('Ollama retries without reasoning when the first response uses its budget without final content', async () => {
  const requests = [];
  const result = await answer([{role:'user',content:'Hello'}], settings, async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json({ message: { content: body.think ? '' : 'Recovered answer', thinking: body.think ? 'unfinished reasoning' : undefined } });
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].think, true);
  assert.equal(requests[0].options.num_predict, 4096);
  assert.equal(requests[1].think, false);
  assert.equal(result, 'Recovered answer');
});
test('Ollama streaming exposes content deltas and hides reasoning chunks', async () => {
  const response = `${JSON.stringify({ message: { thinking: 'private thought', content: '' } })}\n${JSON.stringify({ message: { content: 'Hello' } })}\n${JSON.stringify({ message: { content: ' world' }, done: true })}\n`;
  const deltas = [];
  for await (const delta of streamAnswer([{role:'user',content:'Hello'}], settings, async () => new Response(response))) deltas.push(delta);
  assert.deepEqual(deltas, ['Hello', ' world']);
});
test('provider failures are actionable and do not echo credentials', async () => {
  await assert.rejects(embed(['one'], settings, async () => new Response('secret internal information', {status:404})), /ollama request failed \(404\)/);
});
test('assistant-purpose questions use the saved bot description without requiring knowledge', async () => {
  const result = await groundedChat({ workspaceId: 'unused', bot: { id: 'bot', name: 'Order Guide', description: 'A shopping assistant for finding products' }, message: 'What is this chatbot about?' });
  assert.deepEqual(result, { text: 'Order Guide — A shopping assistant for finding products.', citations: [] });
});
