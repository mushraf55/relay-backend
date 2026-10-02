import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDatabaseUrl } from '../src/config/database-url.js';
test('encodes raw password characters and keeps host intact', () => {
  assert.equal(encodeDatabaseUrl('postgresql://postgres:p@ss#word@db.example.com:5432/postgres'), 'postgresql://postgres:p%40ss%23word@db.example.com:5432/postgres');
});
test('does not double encode an encoded password', () => {
  const value = 'postgresql://postgres:p%40ss%25word@db.example.com:5432/postgres';
  assert.equal(encodeDatabaseUrl(value), value);
});
test('rejects a URL without credentials', () => assert.throws(() => encodeDatabaseUrl('https://example.com')));
