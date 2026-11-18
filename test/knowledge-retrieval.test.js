import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/features/ai/provider.js';
import { selectGroundedMatches } from '../src/features/ai/chat-service.js';

test('knowledge is chunked, relevant excerpts are retrieved, and weak semantic matches are refused', () => {
  const chunks = chunkText('Relay supports PDF knowledge. '.repeat(120), 500, 50);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].slice(-50), chunks[1].slice(0, 50));

  const indexed = chunks.map((content, index) => ({
    source_id: 'guide',
    title: 'Relay guide',
    source_url: 'https://example.com/guide',
    content,
    distance: index === 0 ? 0.22 : 0.81,
    match_type: 'semantic',
  }));
  const matches = selectGroundedMatches(indexed, { maxDistance: 0.45 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source_id, 'guide');
  assert.deepEqual(selectGroundedMatches([{ ...indexed[0], distance: 0.7 }], { maxDistance: 0.45 }), []);
});
