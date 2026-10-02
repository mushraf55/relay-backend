import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, validateUpload } from '../src/features/knowledge/extraction.js';

const file = (name, bytes) => ({ originalname: name, buffer: Buffer.from(bytes), size: Buffer.byteLength(bytes) });
test('accepts UTF-8 text and extracts normalized content', async () => {
  const input = file('guide.md', '# Guide\r\nHello');
  assert.equal(validateUpload(input).contentType, 'text/markdown');
  assert.equal(await extractText(input.buffer, 'text/markdown'), '# Guide\nHello');
});
test('rejects disguised and binary uploads', () => {
  assert.throws(() => validateUpload(file('fake.pdf', 'not a pdf')), /valid PDF/);
  assert.throws(() => validateUpload(file('binary.txt', Buffer.from([0, 1, 2]))), /binary data/);
  assert.throws(() => validateUpload(file('script.exe', 'hello')), /Supported files/);
});
test('accepts files through 10 MB and rejects larger uploads', () => {
  assert.doesNotThrow(() => validateUpload({ ...file('large.txt', 'hello'), size: 10 * 1024 * 1024 }));
  assert.throws(() => validateUpload({ ...file('too-large.txt', 'hello'), size: 10 * 1024 * 1024 + 1 }), /smaller than 10 MB/);
});
test('does not cap extracted document characters below the upload limit', async () => {
  const contents = 'a'.repeat(1_000_001);
  assert.equal((await extractText(Buffer.from(contents), 'text/plain')).length, contents.length);
});
