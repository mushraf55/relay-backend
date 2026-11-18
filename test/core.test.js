import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, streamAnswer } from '../src/features/ai/provider.js';
import { validateUpload } from '../src/features/knowledge/extraction.js';

test('chunking keeps overlap and the end of the source', () => {
  const text = 'a'.repeat(4000);
  const chunks = chunkText(text, 1000, 100);
  assert.equal(chunks.length, 5);
  assert.equal(chunks.at(-1).length, 400);
  assert.equal(chunks[0].slice(-100), chunks[1].slice(0, 100));
});

test('small text-based PDF and TXT uploads pass validation', () => {
  const valid = { originalname: 'guide.pdf', mimetype: 'application/pdf', size: 20, buffer: Buffer.from('%PDF-1.7\ntext content') };
  assert.deepEqual(validateUpload(valid), { extension: '.pdf', contentType: 'application/pdf' });
  assert.deepEqual(validateUpload({ ...valid, originalname: 'guide.txt', mimetype: 'text/plain', buffer: Buffer.from('Readable text') }), { extension: '.txt', contentType: 'text/plain' });
  assert.throws(() => validateUpload({ ...valid, originalname: 'guide.exe' }), /PDF and TXT/);
  assert.throws(() => validateUpload({ ...valid, buffer: Buffer.from('not a pdf') }), /valid PDF/);
  assert.throws(() => validateUpload({ ...valid, size: 5 * 1024 * 1024 + 1 }), /smaller than 5 MB/);
});

test('chat completion streams only assistant text deltas', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n';
  const settings = { chatBaseUrl: 'https://example.test/v1', chatApiKey: 'test', chatModel: 'test-model' };
  const deltas = [];
  for await (const delta of streamAnswer([{ role: 'user', content: 'Hi' }], settings, async () => new Response(body))) deltas.push(delta);
  assert.deepEqual(deltas, ['Hello', ' world']);
});
